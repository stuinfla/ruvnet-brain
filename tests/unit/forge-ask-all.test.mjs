// tests/unit/forge-ask-all.test.mjs — forge-ask-all makes the whole bundle behave like ONE brain:
// discover the repos in a bundle, pool per-repo hits, rerank on a common scale, and boost the repo the
// question names. discoverRepos is tested against a REAL temp dir; searchAll's orchestration is tested
// with the two heavy deps (per-repo retrieval + cross-encoder rerank) mocked, so we assert the
// observable cross-repo contract without the 512MB brain or any model. Drafted by agentic-qe
// (`aqe test generate kb/forge-ask-all.mjs`, 30 assertions); rewritten here to be runnable + contract-focused.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the two heavy collaborators by the SAME absolute path forge-ask-all.mjs imports them from.
vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/forge-rerank.mjs', () => ({ rerankPairs: vi.fn() }));

import { deployedFamilyReposFromQuery, discoverRepos, searchAll } from '../../kb/forge-ask-all.mjs';
import { searchKb } from '../../kb/forge-ask.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';

function mkdirWith(names) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faa-'));
  for (const n of names) fs.writeFileSync(path.join(d, n), 'x');
  return d;
}
const hit = (over = {}) => ({ path: 'p/doc.md', title: 'T', fullText: 'body', bestDistance: 0.1, ...over });

describe('discoverRepos — which repos live in a bundle dir', () => {
  it('lists sorted, unique repo base names from *.rvf stores', () => {
    const d = mkdirWith(['zebra.rvf', 'alpha.rvf', 'beta.rvf']);
    expect(discoverRepos(d)).toEqual(['alpha', 'beta', 'zebra']);
  });
  it('collapses a repo\'s plain + .big variant into ONE repo', () => {
    const d = mkdirWith(['ruvector.rvf', 'ruvector.big.rvf', 'safla.rvf']);
    expect(discoverRepos(d)).toEqual(['ruvector', 'safla']);
  });
  it('excludes .idmap/.embed sidecars and non-.rvf files', () => {
    const d = mkdirWith(['ruvector.rvf', 'ruvector.idmap.rvf', 'ruvector.embed.rvf', 'readme.md', 'meta.json', 'plain']);
    expect(discoverRepos(d)).toEqual(['ruvector']);
  });
  it('keeps dotted repo names intact (dspy.ts)', () => {
    const d = mkdirWith(['dspy.ts.rvf']);
    expect(discoverRepos(d)).toEqual(['dspy.ts']);
  });
  it('returns [] for a dir with no stores', () => {
    const d = mkdirWith(['README.md']);
    expect(discoverRepos(d)).toEqual([]);
  });
});

describe('deployedFamilyReposFromQuery — exact deployed-family boundary', () => {
  it('requires at least two deployed members before treating an alias as a family', () => {
    const d = mkdirWith([]);
    fs.writeFileSync(path.join(d, 'repo-aliases.json'), JSON.stringify({
      makerkit: ['makerkit-source', 'makerkit-ix'],
    }));
    expect(deployedFamilyReposFromQuery('Explain MakerKit', d, ['makerkit-source'])).toEqual([]);
  });

  it('does not match a family name embedded inside a different token', () => {
    const d = mkdirWith([]);
    fs.writeFileSync(path.join(d, 'repo-aliases.json'), JSON.stringify({
      makerkit: ['makerkit-source', 'makerkit-ix'],
    }));
    expect(deployedFamilyReposFromQuery(
      'Explain notmakerkit behavior',
      d,
      ['makerkit-source', 'makerkit-ix'],
    )).toEqual([]);
  });
});

describe('searchAll — cross-repo pool + rerank + name-boost', () => {
  beforeEach(() => {
    vi.mocked(searchKb).mockReset();
    vi.mocked(rerankPairs).mockReset();
    // rerank passes candidates through, assigning a per-repo ceScore (daa ranks above safla by default).
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands.map((c) => ({ ...c, ceScore: c.repo === 'daa' ? 1.0 : 0.5 })));
  });

  it('reports the repos searched, per-repo hit counts, and the pooled candidate total', async () => {
    const d = mkdirWith(['safla.rvf', 'daa.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) =>
      name === 'safla' ? [hit(), hit()] : [hit()]); // safla:2, daa:1
    const out = await searchAll({ dir: d, query: 'general question about vectors' });
    expect(out.repos).toEqual(['daa', 'safla']);
    expect(out.perRepo).toEqual({ safla: 2, daa: 1 });
    expect(out.pooled).toBe(3);
    expect(Array.isArray(out.results)).toBe(true);
  });

  it('labels every returned passage with the repo it came from', async () => {
    const d = mkdirWith(['safla.rvf', 'daa.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit()]);
    const out = await searchAll({ dir: d, query: 'general question' });
    for (const r of out.results) expect(['safla', 'daa']).toContain(r.repo);
  });

  it('honors k — never returns more than k results', async () => {
    const d = mkdirWith(['a.rvf', 'b.rvf', 'c.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit(), hit()]);
    const out = await searchAll({ dir: d, query: 'q', k: 2 });
    expect(out.results.length).toBeLessThanOrEqual(2);
  });

  it('boosts the repo the question NAMES so it outranks a higher-reranked sibling', async () => {
    const d = mkdirWith(['safla.rvf', 'daa.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({ repo: name })]);
    // Default rerank puts daa (1.0) above safla (0.5); naming "safla" adds +2.0 → safla wins.
    const out = await searchAll({ dir: d, query: 'what can safla do for me' });
    expect(out.results[0].repo).toBe('safla');
    expect(out.results[0].nameBoosted).toBe(true);
  });

  it('boosts a 3-char store name (rvm) — the old >=4 floor silently exempted rvm/daa', async () => {
    // Regression guard for the n-19 misroute: "Can RVM partition hardware…" names the rvm store,
    // but the boost's old length floor (>=4) never fired for it, so ruvector's vendored crates/rvm/
    // copy outranked rvm's own userguide. Word-boundary matching keeps 3-char names safe.
    const d = mkdirWith(['rvm.rvf', 'daa.rvf', 'ruvector.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({ repo: name })]);
    // Default rerank gives every repo 0.5 except daa (1.0); naming "RVM" adds +2.0 → rvm wins.
    const out = await searchAll({ dir: d, query: 'Can RVM partition hardware into isolated guests?' });
    expect(out.results[0].repo).toBe('rvm');
    expect(out.results[0].nameBoosted).toBe(true);
  });

  it('does NOT fire a 3-char name boost on a substring (word boundary still required)', async () => {
    const d = mkdirWith(['rvm.rvf', 'daa.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({ repo: name })]);
    // "rvms" / "daap" contain the store names only as substrings — no boost, daa's 1.0 stays on top.
    const out = await searchAll({ dir: d, query: 'how do rvms and daap servers work' });
    expect(out.results[0].repo).toBe('daa'); // won by rerank score, not by boost
    expect(out.results.every((r) => !r.nameBoosted)).toBe(true);
  });

  it('does NOT boost when the query names no repo (sibling ranking preserved)', async () => {
    const d = mkdirWith(['safla.rvf', 'daa.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit()]);
    const out = await searchAll({ dir: d, query: 'how are embeddings stored on disk' });
    expect(out.results[0].repo).toBe('daa'); // daa's 1.0 stays on top
    expect(out.results.every((r) => !r.nameBoosted)).toBe(true);
  });

  it('restricts the search to an explicit repos list', async () => {
    const d = mkdirWith(['safla.rvf', 'daa.rvf', 'qudag.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit()]);
    const out = await searchAll({ dir: d, query: 'q', repos: ['daa'] });
    expect(out.repos).toEqual(['daa']);
    expect(vi.mocked(searchKb).mock.calls.every(([a]) => a.name === 'daa')).toBe(true);
  });

  it.each([
    ['agentx', 'In the agentx project, what shared comment state, data schemas, and DOM update behavior do its web pages depend on?'],
    ['cognitum-meta-proxy-dist', 'In the cognitum-meta-proxy-dist repository, what is meta-proxy-dist, what problem does it solve, and how is it intended to be used?'],
  ])('keeps an explicit natural project scope bounded to %s without requiring a capability card', async (repo, query) => {
    const d = mkdirWith([`${repo}.rvf`, 'unrelated.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({ repo: name, path: `${name}/README.md` })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 1 })));

    const out = await searchAll({ dir: d, query, allowFullCorpus: false });

    expect(out.repos).toEqual([repo]);
    expect(vi.mocked(searchKb).mock.calls.map(([args]) => args.name)).toEqual([repo]);
    expect(out.routing).toMatchObject({ attempted: true, accepted: true, confidence: 'named' });
  });

  it.each([
    ['fact', 'What fact supports this vector-search claim?'],
    ['app', 'How does this app work in the current project?'],
  ])('does not treat the generic short name %s as a natural project scope', async (repo, query) => {
    const d = mkdirWith([`${repo}.rvf`, 'unrelated.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit()]);

    const out = await searchAll({ dir: d, query, allowFullCorpus: false });

    expect(out.repos).toEqual([]);
    expect(vi.mocked(searchKb)).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({ attempted: true, accepted: false, fallback: 'ask-to-narrow' });
  });

  it('is resilient: a repo whose retrieval THROWS is recorded as an error, not a crash', async () => {
    const d = mkdirWith(['safla.rvf', 'daa.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) => {
      if (name === 'daa') throw new Error('boom');
      return [hit()];
    });
    const out = await searchAll({ dir: d, query: 'q' });
    expect(out.perRepo.safla).toBe(1);
    expect(String(out.perRepo.daa)).toMatch(/^ERR:/);
  });

  it('preserves per-repo attribution when repos resolve OUT OF ORDER (Promise.all fan-out)', async () => {
    // Regression guard for the serial-loop -> Promise.all migration: each map callback must close
    // over its OWN `name`, not a shared/mutated loop variable. Forces alpha to resolve LAST (a delay)
    // while beta resolves immediately, so a broken closure would mislabel one repo's hits as the other's.
    const d = mkdirWith(['alpha.rvf', 'beta.rvf']);
    vi.mocked(searchKb).mockImplementation(async ({ name }) => {
      if (name === 'alpha') await new Promise((r) => setTimeout(r, 20));
      return [hit({ path: `${name}/doc.md` })];
    });
    const out = await searchAll({ dir: d, query: 'q' });
    const repoOf = Object.fromEntries(out.results.map((r) => [r.path, r.repo]));
    expect(repoOf['alpha/doc.md']).toBe('alpha');
    expect(repoOf['beta/doc.md']).toBe('beta');
    expect(out.perRepo).toEqual({ alpha: 1, beta: 1 });
  });

  it('gives the shared concepts store a deeper retrieval pool than a single repo', async () => {
    const d = mkdirWith(['concepts.rvf', 'safla.rvf']);
    vi.mocked(searchKb).mockResolvedValue([hit()]);
    await searchAll({ dir: d, query: 'q', pool: 8 });
    const conceptsCall = vi.mocked(searchKb).mock.calls.find(([a]) => a.name === 'concepts');
    const saflaCall = vi.mocked(searchKb).mock.calls.find(([a]) => a.name === 'safla');
    expect(conceptsCall[0].k).toBeGreaterThanOrEqual(24);
    expect(saflaCall[0].k).toBe(8);
  });

  it('uses the full source path for detailed what/how questions even when a lexical preview matches', async () => {
    const d = mkdirWith(['concepts.rvf', 'rulake.rvf', 'ruflo.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## ruvector',
      'Single-file RVF vector search with HNSW and TypeScript SDK backends.',
      '## ruflo',
      'Agent orchestration and project memory.',
      '## rulake',
      'Witness-verified vector read cache.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'ruvector.meta.json'), JSON.stringify({
      entries: {
        'chunk:sdk': {
          path: 'npm/packages/rvf/src/index.ts',
          kind: 'source',
          title: '@ruvector/rvf TypeScript SDK',
          preview: 'RvfDatabase resolves its native or WASM backend at runtime.',
        },
      },
    }));
    // This query asks what the SDK exposes, so recovery's implementation-proof boundary requires
    // complete source-bearing evidence before the router may accept the scoped result. A compact
    // metadata preview is enough for a yes/no capability check, but not a compound inventory.
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({
      path: `${name}/source.ts`,
      fullText: 'export class RvfDatabase {}',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: 'Can @ruvector/rvf expose RvfDatabase, and how is its backend resolved at runtime?',
    });
    expect(out.repos).toEqual(['ruvector']);
    expect(out.routing).toMatchObject({ attempted: true, accepted: true, confidence: 'named' });
    expect(new Set(vi.mocked(searchKb).mock.calls.map(([args]) => args.name)))
      .toEqual(new Set(['ruvector']));
  });

  it('answers a card-covered capability from lexical source witnesses without loading either model', async () => {
    const d = mkdirWith(['concepts.rvf', 'ruflo.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## ruvector',
      'Single-file RVF vector search with HNSW indexing in an .rvf binary container.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'ruvector.meta.json'), JSON.stringify({
      entries: {
        'chunk:decoy': {
          path: 'src/unrelated.ts',
          kind: 'source',
          title: 'Unrelated JSON store',
          preview: 'Persists an unrelated application database to a single JSON file on disk.',
        },
        'chunk:index': {
          path: 'crates/rvf/rvf-index/Cargo.toml',
          kind: 'manifest',
          title: 'rvf-index',
          preview: 'RuVector Format progressive HNSW indexing with Layer A/B/C tiered search.',
        },
        'chunk:format': {
          path: 'crates/rvf/README.md',
          kind: 'doc',
          title: 'RVF file format',
          preview: 'A single-file .rvf binary container with a persisted HNSW index segment.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, 'ruvector.passages.jsonl'), [
      JSON.stringify({
        path: 'crates/rvf/rvf-index/Cargo.toml',
        text: 'RuVector Format progressive HNSW indexing with Layer A/B/C tiered search.',
      }),
      JSON.stringify({
        path: 'crates/rvf/README.md',
        text: 'A single-file .rvf binary container stores its persisted HNSW index segment.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('the source-card lane must not load the embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('the source-card lane must not load the reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Does ruvector support HNSW indexing stored in a single file on disk?',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      attempted: true,
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation).toMatchObject({
      required: true,
      verdict: 'proven',
      implementationSources: ['ruvector/crates/rvf/rvf-index/Cargo.toml'],
    });
    expect(out.corpusAge).toMatchObject({
      oldestRepo: 'ruvector',
    });
    expect(out.corpusAge.oldestDays).toBeGreaterThanOrEqual(0);
    expect(out.corpusAge.newestDays).toBeGreaterThanOrEqual(0);
    expect(out.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repo: 'ruvector',
        path: 'crates/rvf/rvf-index/Cargo.toml',
        evidenceClass: 'implementation',
      }),
    ]));
    expect(out.results.every((result) =>
      !String(result.path).startsWith('capability-cards.md#'))).toBe(true);
    expect(out.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/unrelated.ts' }),
    ]));
    const answer = out.results.map((result) => result.fullText).join('\n').toLowerCase();
    expect(answer).toContain('hnsw');
    expect(answer).toMatch(/single-file|\.rvf/);

    const portable = await searchAll({
      dir: d,
      query: 'I want a vector database that lives in one binary file I can copy around.',
    });
    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(portable.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(portable.results.map((result) => result.fullText).join('\n')).toMatch(
      /\.rvf[\s\S]*binary container|single-file/i,
    );
  });

  it('proves Top-002 from ExplainableRecall source despite why and inflected capability terms', async () => {
    const d = mkdirWith(['agentdb.rvf', 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## agentdb',
      'Agent memory with explainable recall. Audit why a result was recalled via feature attributions.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'agentdb.meta.json'), JSON.stringify({
      entries: {
        'chunk:explainable': {
          path: 'src/controllers/ExplainableRecall.ts',
          kind: 'source',
          title: 'ExplainableRecall.ts',
          preview: 'ExplainableRecall can explain why it recalled a particular memory. Every retrieval returns a minimal hitting set of facts that justify the answer.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-002 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-002 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Can AgentDB explain why it recalled a particular memory?',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation).toMatchObject({
      verdict: 'proven',
      implementationSources: ['agentdb/src/controllers/ExplainableRecall.ts'],
    });
    expect(out.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'src/controllers/ExplainableRecall.ts',
        evidenceClass: 'implementation',
      }),
    ]));
    expect(out.results.every((result) =>
      !String(result.path).startsWith('capability-cards.md#'))).toBe(true);

    const causal = await searchAll({
      dir: d,
      query: 'Agent memory that can tell me the causal chain behind a recall.',
    });
    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(causal.repos).toEqual(['agentdb']);
    expect(causal.results.map((result) => result.fullText).join('\n')).toMatch(
      /explain[\s\S]*recall/i,
    );
  });

  it('proves a COW memory branch analogy from bounded branch and recovery source witnesses', async () => {
    const repo = ['agent', 'icow'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Copy-On-Write vector branching creates isolated agent memory branches that can be rolled back or discarded.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        branch: {
          path: 'src/index.js',
          kind: 'source',
          title: 'COW memory implementation',
          preview: 'Copy-On-Write vector branching for embedded multi-agent memory.',
        },
        recovery: {
          path: 'examples/rollback-quarantine.mjs',
          kind: 'source',
          title: 'Branch recovery example',
          preview: 'An agent vector memory branch can roll back or be discarded.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/index.js',
        text: 'Copy-On-Write vector branching for embedded multi-agent memory. fork() creates a COW branch.',
      }),
      JSON.stringify({
        path: 'examples/rollback-quarantine.mjs',
        text: 'An agent vector memory branch can roll back; discard the branch and the shared base stays clean.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-005 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-005 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} branch an agent's vector memory like git branches code?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n').toLowerCase();
    expect(answer).toContain('copy-on-write');
    expect(answer).toMatch(/roll back|discard the branch/);
  });

  it('proves cross-module hardware partition isolation without counting negated guest prose', async () => {
    const repo = ['r', 'vm'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A microhypervisor for hardware-grade partition isolation and sandboxed guest workloads.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        hal: {
          path: 'crates/hal/src/lib.rs',
          kind: 'source',
          title: 'Hardware abstraction',
          preview: 'Hardware abstraction for the microhypervisor with guest physical to host physical page mapping.',
        },
        partitions: {
          path: 'crates/partition/src/lib.rs',
          kind: 'source',
          title: 'Partition isolation',
          preview: 'Partition lifecycle and isolation for the microhypervisor.',
        },
        guests: {
          path: 'crates/guest/src/lib.rs',
          kind: 'source',
          title: 'Sandboxed guests',
          preview: 'Sandboxed guest workloads execute within isolated partitions.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'crates/hal/src/lib.rs',
        text: 'pub trait MmuOps { fn map_guest_physical_to_host_physical(); } // hardware boundary',
      }),
      JSON.stringify({
        path: 'crates/partition/src/lib.rs',
        text: 'Partitions are the unit of isolation and fault containment in the microhypervisor.',
      }),
      JSON.stringify({
        path: 'crates/guest/src/lib.rs',
        text: 'pub struct GuestRuntime; // sandboxed guest workloads execute within isolated partitions',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('partition confirmation must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('partition confirmation must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} partition hardware into isolated guest partitions?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/crates/hal/src/lib.rs`,
      `${repo}/crates/partition/src/lib.rs`,
      `${repo}/crates/guest/src/lib.rs`,
    ]));
  });

  it('does not prove guest hardware support from an explicitly negated source sentence', async () => {
    const repo = ['r', 'vm'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A microhypervisor with partition isolation.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        partitions: {
          path: 'crates/partition/src/lib.rs',
          kind: 'source',
          title: 'Partition isolation',
          preview: 'Partition isolation for the microhypervisor; no emulated hardware and no guest BIOS.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), JSON.stringify({
      path: 'crates/partition/src/lib.rs',
      text: 'Partitions are the unit of isolation. A partition has no emulated hardware and no guest BIOS.',
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'docs/fallback.md',
      kind: 'doc',
      fullText: 'Normal retrieval must handle this unresolved architecture question.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} partition hardware into isolated guest partitions?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('proves a language-port confirmation with implementation plus a source-bound guide', async () => {
    const repo = ['dspy', '.ts'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A declarative framework for LLM pipelines built from composable modules and signatures in TypeScript.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        manifest: {
          path: 'package.json',
          kind: 'manifest',
          title: repo,
          preview: 'Advanced declarative AI framework for TypeScript with pipeline modules.',
        },
        module: {
          path: 'src/core/module.ts',
          kind: 'source',
          title: 'Module',
          preview: 'TypeScript module base; every module defines an input and output signature.',
        },
        guide: {
          path: 'docs/guides/getting-started.md',
          kind: 'doc',
          title: `Getting started with ${repo}`,
          preview: 'A TypeScript port bringing declarative language model programming to the TypeScript ecosystem.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'package.json',
        text: 'Advanced declarative AI framework for TypeScript. Keywords: pipeline, modules, signatures.',
      }),
      JSON.stringify({
        path: 'src/core/module.ts',
        text: 'export abstract class Module<Input, Output> { abstract signature: Signature<Input, Output>; }',
      }),
      JSON.stringify({
        path: 'docs/guides/getting-started.md',
        text: 'A TypeScript port bringing declarative language model programming to the TypeScript ecosystem.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-010 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-010 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} bring DSPy-style declarative pipelines to TypeScript?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources.length).toBeGreaterThanOrEqual(1);
    expect(out.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'docs/guides/getting-started.md',
        evidenceClass: 'documentation',
      }),
    ]));
  });

  it('answers a single-capability confirmation despite an unrelated malformed surrogate in metadata', async () => {
    const repo = ['wasm', '-neural'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A neural network runtime that compiles to WASM for WebAssembly hosts.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), [
      '{"entries":{',
      '"wasm":{"path":"src/wasm_runtime.rs","kind":"source","title":"WASM runtime",',
      '"preview":"WebAssembly WASM runtime for neural network inference."},',
      '"bad":{"path":"docs/bad.md","kind":"doc","title":"bad","preview":"bad \\\\ud83d\\\\u0000"}}}',
    ].join(''));
    vi.mocked(searchKb).mockRejectedValue(new Error('WASM confirmation must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('WASM confirmation must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Is ${repo} usable from WebAssembly?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources)
      .toContain(`${repo}/src/wasm_runtime.rs`);
  });

  it('proves a shipped card enumeration only when source witnesses cover every listed item', async () => {
    const repo = ['agentic', 'flow'].join('-');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Agent orchestration across three swarm topologies (mesh, hierarchical, ring).',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        mesh: {
          path: 'tests/parallel/mesh-swarm-test.js',
          kind: 'source',
          title: 'Mesh swarm',
          preview: 'Mesh Topology Swarm Test. Tests peer-to-peer coordination with full connectivity.',
        },
        hierarchical: {
          path: 'tests/parallel/hierarchical-swarm-test.js',
          kind: 'source',
          title: 'Hierarchical swarm',
          preview: 'Hierarchical Topology Swarm Test. Tests coordinator-worker delegation.',
        },
        ring: {
          path: 'tests/parallel/ring-swarm-test.js',
          kind: 'source',
          title: 'Ring swarm',
          preview: 'Ring Topology Swarm Test. Tests circular message passing with a token ring.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-003 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-003 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What swarm topologies does ${repo} ship?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/tests/parallel/mesh-swarm-test.js`,
      `${repo}/tests/parallel/hierarchical-swarm-test.js`,
      `${repo}/tests/parallel/ring-swarm-test.js`,
    ]));
    const answerEvidence = out.results.map((result) => result.fullText).join(' ').toLowerCase();
    expect(answerEvidence).toContain('mesh');
    expect(answerEvidence).toContain('hierarchical');
    expect(answerEvidence).toContain('ring');
  });

  it('proves a quantity-checked dash-list enumeration from documentation plus a manifest', async () => {
    const repo = ['phase', '-method'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A methodology with five phases — Specification, Pseudocode, Architecture, Refinement, Completion — and quality gates.',
    ].join('\n'));
    const phases = 'Specification, Pseudocode, Architecture, Refinement, and Completion';
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        readme: {
          path: 'README.md',
          kind: 'doc',
          title: 'Five-phase method',
          preview: `The workflow phases are ${phases}.`,
        },
        manifest: {
          path: 'package.json',
          kind: 'manifest',
          title: repo,
          preview: `Package for a framework covering ${phases}.`,
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Phase enumeration must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Phase enumeration must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What are the five phases of ${repo}?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toContain(`${repo}/package.json`);
    const answerEvidence = out.results.map((result) => result.fullText).join(' ').toLowerCase();
    for (const phase of ['specification', 'pseudocode', 'architecture', 'refinement', 'completion']) {
      expect(answerEvidence).toContain(phase);
    }
  });

  it('falls through when source cannot prove every item in a shipped card enumeration', async () => {
    const repo = ['agentic', 'flow'].join('-');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Agent orchestration across three swarm topologies (mesh, hierarchical, ring).',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        mesh: {
          path: 'src/coordination/mesh.ts',
          kind: 'source',
          title: 'Mesh swarm',
          preview: 'Mesh topology swarm coordination.',
        },
        hierarchical: {
          path: 'src/coordination/hierarchical.ts',
          kind: 'source',
          title: 'Hierarchical swarm',
          preview: 'Hierarchical topology swarm coordination.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/coordination/full.ts',
      kind: 'source',
      fullText: 'Complete source is available only through the full retrieval path.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `What swarm topologies does ${repo} ship?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('proves each clause of a compound conceptual question from distinct source witnesses', async () => {
    const repo = ['ru', 'lake'].join('');
    const displayName = ['Ru', 'Lake'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Vector read cache with witness-anchored bundles for provenance-verifiable retrieval.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        cache: {
          path: 'crates/core/src/cache.rs',
          kind: 'source',
          title: 'Vector read cache',
          preview: 'RaBitQ-compressed cache for vectors in the read path.',
        },
        witness: {
          path: 'sdk/node/package.json',
          kind: 'manifest',
          title: 'Witness verification',
          preview: 'Witness-anchored memory with provenance-verifiable retrieval.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-006 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-006 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What does ${displayName} cache, and what is a witness?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/crates/core/src/cache.rs`,
      `${repo}/sdk/node/package.json`,
    ]));
  });

  it('proves an unpunctuated compound question when source extends the routing card', async () => {
    const repo = ['ruf', 'lo'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Coordinates agent swarms working in parallel.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        coordinator: {
          path: 'src/SwarmCoordinator.ts',
          kind: 'source',
          title: 'Swarm coordinator',
          preview: 'Coordinates multi-agent swarms that work together on one goal.',
        },
        topologies: {
          path: 'src/topologies.ts',
          kind: 'source',
          title: 'Swarm topologies',
          preview: 'Coordinates agent swarms using mesh, hierarchical, or ring topology.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/SwarmCoordinator.ts',
        text: 'export class SwarmCoordinator { coordinate(agents) {} }',
      }),
      JSON.stringify({
        path: 'src/topologies.ts',
        text: 'export type SwarmTopology = "mesh" | "hierarchical" | "ring";',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Compound concepts must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Compound concepts must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What is a swarm in ${repo} and what topologies does it support?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/SwarmCoordinator.ts`,
      `${repo}/src/topologies.ts`,
    ]));
    expect(out.results.map((result) => result.fullText).join('\n'))
      .toContain('export class SwarmCoordinator');
  });

  it('falls through when a compound conceptual question has no source witness for one clause', async () => {
    const repo = ['ru', 'lake'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Vector read cache with witness-anchored bundles for provenance-verifiable retrieval.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        cache: {
          path: 'crates/core/src/cache.rs',
          kind: 'source',
          title: 'Vector read cache',
          preview: 'RaBitQ-compressed cache for vectors in the read path.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'crates/core/src/fallback.rs',
      kind: 'source',
      fullText: 'Full retrieval evidence for the second clause.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `What does ${repo} cache, and what is a witness?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('proves a singular architecture definition only from multiple source witnesses', async () => {
    const repo = ['orbit', 'loop'].join('');
    const displayName = ['Orbit', 'Loop'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Self-aware feedback loop architecture with meta-cognitive monitoring and policy adaptation.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        feedback: {
          path: 'src/core/feedback-loop.ts',
          kind: 'source',
          title: 'SelfAwareFeedbackLoop',
          preview: 'A self-aware feedback loop monitors and evaluates system behavior.',
        },
        adaptation: {
          path: 'src/core/policy-adaptation.ts',
          kind: 'source',
          title: 'Policy adaptation',
          preview: 'The self-modification layer applies policy adaptation to system behavior.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/core/feedback-loop.ts',
        text: 'export class SelfAwareFeedbackLoop { monitor() {} evaluate() {} }',
      }),
      JSON.stringify({
        path: 'src/core/policy-adaptation.ts',
        text: 'export class PolicyAdapter { adaptPolicy() { return "self-modification"; } }',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-007 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-007 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What is ${displayName}'s self-aware feedback loop architecture?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/core/feedback-loop.ts`,
      `${repo}/src/core/policy-adaptation.ts`,
    ]));
    expect(out.results.map((result) => result.fullText).join('\n')).toContain('PolicyAdapter');
  });

  it('answers an identity-plus-purpose question from the card and multiple source surfaces', async () => {
    const repo = ['sense', '-view'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Camera-free WiFi sensing uses channel state information to detect human presence, pose, breathing, and heart rate.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        csi: {
          path: 'src/csi.rs',
          kind: 'source',
          title: 'WiFi CSI sensing',
          preview: 'Channel state information from WiFi sensors.',
        },
        presence: {
          path: 'src/presence.rs',
          kind: 'source',
          title: 'Human presence',
          preview: 'Detect human presence, pose, breathing, and heart rate without a camera.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Identity-purpose must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Identity-purpose must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What is ${repo} and what problem does it solve?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toHaveLength(2);
    const answer = out.results.map((result) => result.fullText).join('\n').toLowerCase();
    expect(answer).toContain('channel state information');
    expect(answer).toContain('human presence');
  });

  it('treats a named identity-plus-audience question as an implementation-backed overview', async () => {
    const repo = ['agent', '-memory-db'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A cognitive database for AI coding agents and developers, with durable persistent memory that survives across sessions, vector search, graph relationships, and structured agent state.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        manifest: {
          path: 'package.json',
          kind: 'manifest',
          title: 'Agent memory package',
          preview: 'Durable persistent memory for AI coding agents that survives across sessions.',
        },
        server: {
          path: 'src/mcp.ts',
          kind: 'source',
          title: 'Agent memory server',
          preview: 'Vector search, graph relationships, and structured agent state for developers.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Identity-audience overview must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Identity-audience overview must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What is ${repo} and who is it for?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toHaveLength(2);
    const answer = out.results.map((result) => result.fullText).join('\n').toLowerCase();
    expect(answer).toContain('persistent memory');
    expect(answer).toContain('vector search');
    expect(answer).toContain('graph relationships');
  });

  it('falls through when a singular architecture definition has only one source witness', async () => {
    const repo = ['orbit', 'loop'].join('');
    const displayName = ['Orbit', 'Loop'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Self-aware feedback loop architecture with meta-cognitive monitoring and policy adaptation.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        feedback: {
          path: 'src/core/feedback-loop.ts',
          kind: 'source',
          title: 'SelfAwareFeedbackLoop',
          preview: 'A self-aware feedback loop monitors and evaluates system behavior.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/core/full-definition.ts',
      kind: 'source',
      fullText: 'Full definition evidence from normal retrieval.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `What is ${displayName}'s self-aware feedback loop architecture?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('keeps source-backed proof inside the explicitly named repo', async () => {
    const repo = ['dspy', '.ts'].join('');
    const distractor = ['other', '-framework'].join('');
    const d = mkdirWith([`${repo}.rvf`, `${distractor}.rvf`, 'concepts.rvf', 'unrelated.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A TypeScript implementation of DSPy with declarative pipelines, composable modules, and LLM signatures.',
      `## ${distractor}`,
      'A TypeScript framework with a FANN-style neural network API.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        pipeline: {
          path: 'src/core/pipeline.ts',
          kind: 'source',
          title: 'Pipeline',
          preview: 'Brings DSPy-style declarative pipelines to TypeScript with composable modules.',
        },
        signature: {
          path: 'src/core/signature.ts',
          kind: 'source',
          title: 'DSPy signature',
          preview: 'LLM signatures define inputs and outputs for DSPy modules.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${distractor}.meta.json`), JSON.stringify({
      entries: {
        types: {
          path: 'src/neural-network.ts',
          kind: 'source',
          title: 'TypeScript style declarations',
          preview: 'TypeScript declarations for a FANN-style framework.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-010 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-010 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} bring DSPy-style declarative pipelines to TypeScript?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.repos).toEqual([repo]);
    expect(out.results.every((result) => result.repo === repo)).toBe(true);
    expect(out.implementation.implementationSources).toEqual(expect.arrayContaining([
      `${repo}/src/core/pipeline.ts`,
    ]));
  });

  it('does not substitute a related repo when the explicitly named repo lacks proof', async () => {
    const repo = ['named', '.tool'].join('');
    const distractor = ['other', '-framework'].join('');
    const d = mkdirWith([`${repo}.rvf`, `${distractor}.rvf`, 'concepts.rvf', 'unrelated.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A declarative pipeline framework for TypeScript.',
      `## ${distractor}`,
      'A declarative pipeline framework for TypeScript.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({ entries: {} }));
    fs.writeFileSync(path.join(d, `${distractor}.meta.json`), JSON.stringify({
      entries: {
        source: {
          path: 'src/pipeline.ts',
          kind: 'source',
          title: 'Declarative pipeline',
          preview: 'A declarative pipeline framework for TypeScript.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/full-retrieval.ts',
      kind: 'source',
      fullText: 'Normal retrieval evidence.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} provide declarative pipelines for TypeScript?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
    expect(out.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: distractor, path: 'src/pipeline.ts' }),
    ]));
  });

  it('answers a named product problem overview from diversified source witnesses', async () => {
    const repo = ['reliable', '-tools'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Aggressive caching gives AI tools low-latency access, while a circuit-breaker provides graceful degradation under failure.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        cache: {
          path: 'src/cache/manager.ts',
          kind: 'source',
          title: 'Aggressive cache manager',
          preview: 'Cached access lowers latency for repeated AI tool calls.',
        },
        resilience: {
          path: 'src/resilience/circuit-breaker.ts',
          kind: 'source',
          title: 'Circuit breaker',
          preview: 'Graceful degradation keeps tool execution dependable under failure.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-011 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-011 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What problem does ${repo} solve?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/cache/manager.ts`,
      `${repo}/src/resilience/circuit-breaker.ts`,
    ]));
  });

  it('binds overview documentation claims to the exact implementation paths they cite', async () => {
    const repo = ['fast', '-tools'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Aggressive caching gives AI tools low-latency cached access, while a circuit-breaker provides graceful degradation under failure.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        shallowExample: {
          path: 'examples/cached-client.py',
          kind: 'source',
          title: 'Cached client example',
          preview: 'Setup project imports and module paths.',
        },
        cacheSource: {
          path: 'src/cache/manager.py',
          kind: 'source',
          title: 'Cache manager',
          preview: 'Try relative imports first and add src to the module path.',
        },
        cacheDocs: {
          path: 'docs/cache-integration.md',
          kind: 'doc',
          title: 'Cache integration',
          preview: 'Cache integration implementation details.',
        },
        resilienceDocs: {
          path: 'docs/cache-resilience.md',
          kind: 'doc',
          title: 'Cache resilience',
          preview: 'Cache resilience implementation details.',
        },
        unlinkedOverview: {
          path: 'README.md',
          kind: 'doc',
          title: 'Fast tools overview',
          preview: 'Aggressive caching gives low-latency cached access with circuit-breaker resilience and graceful degradation.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'examples/cached-client.py',
        title: 'Cached client example',
        text: 'Setup project imports and module paths.',
      }),
      JSON.stringify({
        path: 'src/cache/manager.py',
        title: 'Cache manager',
        text: 'Try relative imports first and add src to the module path.',
      }),
      JSON.stringify({
        path: 'docs/cache-integration.md',
        title: 'Cache integration',
        text: 'The cache-first implementation in [`src/cache/manager.py`](src/cache/manager.py:1) gives AI tools low-latency cached access through aggressive caching.',
      }),
      JSON.stringify({
        path: 'docs/cache-resilience.md',
        title: 'Cache resilience',
        text: 'The same [`src/cache/manager.py`](src/cache/manager.py:1) uses a circuit-breaker and graceful degradation to remain dependable under failure.',
      }),
      JSON.stringify({
        path: 'README.md',
        title: 'Fast tools overview',
        text: 'Aggressive caching gives low-latency cached access with circuit-breaker resilience and graceful degradation.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('overview lane must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('overview lane must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What problem does ${repo} solve?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toContain(
      `${repo}/src/cache/manager.py`,
    );
    expect(out.results.map((result) => result.path)).toEqual(expect.arrayContaining([
      'docs/cache-integration.md',
      'docs/cache-resilience.md',
      'src/cache/manager.py',
    ]));
    expect(out.results.map((result) => result.path)).not.toContain('examples/cached-client.py');
    expect(out.results.map((result) => result.path)).not.toContain('README.md');
  });

  it('falls through when a named product overview has only generic source metadata', async () => {
    const repo = ['reliable', '-tools'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Aggressive caching gives AI tools low-latency access, while a circuit-breaker provides graceful degradation under failure.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        generic: {
          path: 'src/index.ts',
          kind: 'source',
          title: 'Project entrypoint',
          preview: 'General project initialization and exports.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/full-overview.ts',
      kind: 'source',
      fullText: 'Normal retrieval evidence for the overview.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `What problem does ${repo} solve?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('answers detailed mechanics only when full source passages provide two exact witnesses', async () => {
    const repo = ['secure', '-bench'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A conformance firewall means the solver never sees the gold fix; grading applies a security regression FAIL_TO_PASS test.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        solver: {
          path: 'scripts/solve.mjs',
          kind: 'source',
          title: 'Reference solver',
          preview: 'Reference conformant solver.',
        },
        evaluator: {
          path: 'scripts/evaluate.mjs',
          kind: 'source',
          title: 'Official evaluator',
          preview: 'Official benchmark evaluator.',
        },
        docs: {
          path: 'README.md',
          kind: 'doc',
          title: 'Benchmark guide',
          preview: 'Conformance overview.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'scripts/solve.mjs',
        title: 'Reference solver',
        text: 'The conformance firewall ensures the solver never sees the gold fix while producing its patch.',
      }),
      JSON.stringify({
        path: 'scripts/evaluate.mjs',
        title: 'Official evaluator',
        text: 'Grading applies the security regression FAIL_TO_PASS test; the gold fix is reserved for validation.',
      }),
      JSON.stringify({
        path: 'README.md',
        title: 'Benchmark guide',
        text: 'The solver never sees the gold fix.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-015 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-015 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `How does ${repo} keep solvers from seeing the gold fix?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/scripts/solve.mjs`,
      `${repo}/scripts/evaluate.mjs`,
    ]));
    expect(out.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', evidenceClass: 'implementation' }),
    ]));
  });

  it('falls through when detailed mechanics have only one implementation witness', async () => {
    const repo = ['secure', '-bench'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A conformance firewall means the solver never sees the gold fix.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        solver: {
          path: 'scripts/solve.mjs',
          kind: 'source',
          title: 'Reference solver',
          preview: 'Reference conformant solver.',
        },
        docs: {
          path: 'README.md',
          kind: 'doc',
          title: 'Benchmark guide',
          preview: 'The solver never sees the gold fix.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'scripts/solve.mjs',
        text: 'The solver never sees the gold fix.',
      }),
      JSON.stringify({
        path: 'README.md',
        text: 'The solver never sees the gold fix.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'scripts/full-mechanics.mjs',
      kind: 'source',
      fullText: 'Normal retrieval evidence for the detailed mechanism.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `How does ${repo} keep solvers from seeing the gold fix?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('answers a pure named identity definition from diversified source witnesses', async () => {
    const repo = ['open', '-agent-cli'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'An open-source implementation of an agent coding CLI with compatible commands and interactive sessions.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        cli: {
          path: 'src/cli.ts',
          kind: 'source',
          title: 'Agent coding CLI',
          preview: 'Interactive CLI commands for coding agents.',
        },
        commands: {
          path: 'src/commands.ts',
          kind: 'source',
          title: 'Compatible commands',
          preview: 'Compatible command sessions implemented in TypeScript.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-016 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-016 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What is ${repo}?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/cli.ts`,
      `${repo}/src/commands.ts`,
    ]));
  });

  it('falls through when a pure named identity definition has generic metadata', async () => {
    const repo = ['open', '-agent-cli'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'An open-source implementation of an agent coding CLI with compatible commands and interactive sessions.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        generic: {
          path: 'src/index.ts',
          kind: 'source',
          title: 'Entrypoint',
          preview: 'General project initialization.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/full-definition.ts',
      kind: 'source',
      fullText: 'Normal retrieval evidence for the identity definition.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `What is ${repo}?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('uses a capability-card product alias to prove the installed store', async () => {
    const cardRepo = ['agent', '-harness-generator'].join('');
    const storeRepo = ['meta', 'harness'].join('');
    const d = mkdirWith([`${storeRepo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${cardRepo}`,
      'Darwin mode evolves structured planner policies, retry policy, and model routing while keeping the underlying model fixed.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${storeRepo}.meta.json`), JSON.stringify({
      entries: {
        planner: {
          path: 'src/darwin/planner.ts',
          kind: 'source',
          title: 'Darwin planner policy',
          preview: 'Evolves structured planner and retry policy variants.',
        },
        routing: {
          path: 'src/darwin/model-routing.ts',
          kind: 'source',
          title: 'Fixed-model routing',
          preview: 'Changes model routing around a fixed underlying model.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Top-021 must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Top-021 must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What does Darwin mode in ${cardRepo} actually mutate?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.repos).toEqual([storeRepo]);
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results.every((result) =>
      !String(result.path).startsWith('capability-cards.md#'))).toBe(true);
  });

  it('answers a retrain-or-evolve contrast with a frozen-model harness proof', async () => {
    const repo = ['meta', 'harness'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Darwin Mode evolves harness variants while the foundation model stays frozen.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        evolution: {
          path: 'src/evolution.ts',
          kind: 'source',
          title: 'Darwin harness evolution',
          preview: 'Darwin Mode evolves structured harness variants and retry policies.',
        },
        invariant: {
          path: 'src/invariant.ts',
          kind: 'source',
          title: 'Frozen foundation model invariant',
          preview: 'The foundation model remains fixed; no retraining occurs while the harness around it evolves.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('The contrast lane must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('The contrast lane must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} retrain the model or evolve the harness around it?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/evolution.ts`,
      `${repo}/src/invariant.ts`,
    ]));
  });

  it('answers a colloquial scaffolding-improvement request with a frozen-model harness proof', async () => {
    const cardRepo = ['agent', '-harness-generator'].join('');
    const storeRepo = ['meta', 'harness'].join('');
    const d = mkdirWith([`${storeRepo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${cardRepo}`,
      'Darwin Mode evolves harness variants while the foundation model stays frozen.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${storeRepo}.meta.json`), JSON.stringify({
      entries: {
        evolution: {
          path: 'src/evolution.ts',
          kind: 'source',
          title: 'Darwin harness evolution',
          preview: 'Darwin Mode evolves structured harness variants and retry policies.',
        },
        invariant: {
          path: 'src/invariant.ts',
          kind: 'source',
          title: 'Frozen foundation model invariant',
          preview: 'The foundation model remains fixed while the harness around it evolves.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Scaffolding proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Scaffolding proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: "How do I improve my agent's scaffolding without swapping out the model itself?",
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results.map((result) => result.fullText).join('\n')).toMatch(
      /evolves[\s\S]*harness variants[\s\S]*model remains fixed/i,
    );
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${storeRepo}/src/evolution.ts`,
      `${storeRepo}/src/invariant.ts`,
    ]));
  });

  it('proves project memory persistence from distinct lifecycle and cwd-store sources', async () => {
    const repo = ['ru', 'flo'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Project memory persists across sessions in a per-project .swarm/memory.db store.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        lifecycle: {
          path: 'src/init.ts',
          kind: 'source',
          title: 'Project initialization',
          preview: 'Persistent memory across sessions uses the hybrid AgentDB backend.',
        },
        store: {
          path: 'src/memory.ts',
          kind: 'source',
          title: 'Project memory path',
          preview: 'The default database path is cwd/.swarm/memory.db; memory store and memory search use it.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Project-memory proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Project-memory proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} persist memory across sessions in a project?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/init.ts`,
      `${repo}/src/memory.ts`,
    ]));
  });

  it('does not mistake a global memory file for a per-project store', async () => {
    const repo = ['ru', 'flo'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Project memory persists across sessions in a per-project .swarm/memory.db store.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        lifecycle: {
          path: 'src/init.ts',
          kind: 'source',
          title: 'Memory lifecycle',
          preview: 'Persistent memory across sessions uses the hybrid AgentDB backend.',
        },
        globalStore: {
          path: 'src/global.ts',
          kind: 'source',
          title: 'Global memory path',
          preview: 'The process stores shared state in /var/lib/global-memory.db.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/cold-result.ts',
      kind: 'source',
      fullText: 'Cold retrieval fallback because project-local storage was not proven.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} persist memory across sessions in a project?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('proves browser vector search from a same-sentence WebAssembly binding manifest', async () => {
    const repo = ['ru', 'vector'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'WASM bindings provide in-browser vector search and nearest-neighbor lookup.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        wasm: {
          path: 'crates/hnsw-wasm/Cargo.toml',
          kind: 'manifest',
          title: 'Browser HNSW WASM',
          preview: 'WebAssembly bindings for hierarchy-aware vector search in browsers.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Browser binding proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Browser binding proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} ship WASM bindings for in-browser vector search?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toEqual([
      `${repo}/crates/hnsw-wasm/Cargo.toml`,
    ]);
  });

  it('does not join a generic WASM binding to a separate browser-search sentence', async () => {
    const repo = ['ru', 'vector'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'WASM bindings provide in-browser vector search and nearest-neighbor lookup.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        ambiguous: {
          path: 'crates/generic-wasm/Cargo.toml',
          kind: 'manifest',
          title: 'Generic WASM',
          preview: 'WebAssembly bindings are available. A separate browser demo discusses vector search.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/cold-result.rs',
      kind: 'source',
      fullText: 'Cold retrieval fallback because the browser binding was not proven.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} ship WASM bindings for in-browser vector search?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('proves provider routing from one implementation source naming all providers', async () => {
    const repo = ['agentic', '-flow'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Multi-provider routing across Anthropic, OpenRouter, and Gemini.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        router: {
          path: 'src/direct-api-agent.ts',
          kind: 'source',
          title: 'Direct API router',
          preview: 'Direct API agent with multi-provider support (Anthropic, OpenRouter, Gemini).',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Provider inventory proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Provider inventory proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} route work across Anthropic, OpenRouter, and Gemini providers?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toEqual([
      `${repo}/src/direct-api-agent.ts`,
    ]);
  });

  it('does not assemble a three-provider router from unrelated source files', async () => {
    const repo = ['agentic', '-flow'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Multi-provider routing across Anthropic, OpenRouter, and Gemini.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        pair: {
          path: 'src/pair.ts',
          kind: 'source',
          title: 'Pair router',
          preview: 'Route work across Anthropic and OpenRouter providers.',
        },
        separate: {
          path: 'src/gemini.ts',
          kind: 'source',
          title: 'Separate Gemini client',
          preview: 'A standalone Gemini provider client.',
        },
      },
    }));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'src/cold-result.ts',
      kind: 'source',
      fullText: 'Cold retrieval fallback because a unified provider router was not proven.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, candidates) =>
      candidates.map((candidate) => ({ ...candidate, ceScore: 7.5 })));

    const out = await searchAll({
      dir: d,
      query: `Can ${repo} route work across Anthropic, OpenRouter, and Gemini providers?`,
    });

    expect(searchKb).toHaveBeenCalled();
    expect(out.routing?.lane).not.toBe('source-backed-card');
  });

  it('answers a named mutation-target question from exact source passages', async () => {
    const repo = ['evolution', '-engine'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Darwin Mode evolutionarily improves agent harnesses under fixed safety rails.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        policy: {
          path: 'src/policy.ts',
          kind: 'source',
          title: 'Policy engine',
          preview: 'Darwin implementation surface.',
        },
        runtime: {
          path: 'package.json',
          kind: 'manifest',
          title: 'Runtime package',
          preview: 'Darwin runtime package.',
        },
        metrics: {
          path: 'src/metrics.ts',
          kind: 'source',
          title: 'Metrics formatting',
          preview: 'Darwin metrics output.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/policy.ts',
        text: 'Darwin Mode mutates structured planner and retry policies, never prompt blobs.',
      }),
      JSON.stringify({
        path: 'package.json',
        text: 'Darwin Mode freezes the model and evolves the harness around it.',
      }),
      JSON.stringify({
        path: 'src/metrics.ts',
        text: 'Darwin Mode reports a mutation score with value.toFixed(2) for model output.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Mutation targets must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Mutation targets must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What does Darwin Mode in ${repo} actually mutate?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n').toLowerCase();
    expect(answer).toContain('structured planner');
    expect(answer).toContain('freezes the model');
    expect(out.implementation.implementationSources).not.toContain(`${repo}/src/metrics.ts`);
  });

  it('answers a named documentation-scope question from delivered docs without claiming code proof', async () => {
    const repo = ['support', '-hub'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Public support documentation covering firmware downloads, installation, onboarding, upgrades, and the issue tracker.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'docs/getting-started.md',
          kind: 'doc',
          title: 'Getting started',
          preview: 'Installation and onboarding guide with firmware download and upgrade instructions.',
        },
        issues: {
          path: 'README.md',
          kind: 'doc',
          title: 'Support home',
          preview: 'Public documentation home with the issue tracker and a place to report issues.',
        },
        api: {
          path: 'docs/api.md',
          kind: 'doc',
          title: 'API reference',
          preview: 'REST endpoint reference.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Documentation scope must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Documentation scope must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What does ${repo} cover?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationRequired: false,
    });
    expect(out.implementation).toMatchObject({
      required: false,
      verdict: 'not-required',
      proofMethod: 'lexical-documentation-card',
    });
    expect(new Set(out.documentationSources)).toEqual(new Set([
      `${repo}/docs/getting-started.md`,
      `${repo}/README.md`,
    ]));
  });

  it('routes living ADR drift questions to source-bound lifecycle and compliance documentation', async () => {
    const repo = ['ru', 'flo'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Multi-agent orchestration, memory, routing, hooks, and development workflows.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'docs/USERGUIDE.md',
          kind: 'doc',
          title: 'User guide',
          preview: 'Living Documentation keeps Architecture Decision Records current and prevents implementation drift.',
        },
        plugin: {
          path: 'plugins/ruflo-adr/README.md',
          kind: 'doc',
          title: 'ADR lifecycle management',
          preview: 'Architecture Decision Records link decisions to code with compliance checking.',
        },
        review: {
          path: 'plugins/ruflo-adr/skills/adr-review/SKILL.md',
          kind: 'skill',
          title: 'ADR review',
          preview: 'Review source changes against accepted decisions for drift.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'docs/USERGUIDE.md',
        text: 'Living Documentation updates ADRs as requirements evolve. The result is implementations that match specifications.',
      }),
      JSON.stringify({
        path: 'plugins/ruflo-adr/README.md',
        text: 'Architecture Decision Records have lifecycle management and compliance checking that scans source diffs for ADR violations.',
      }),
      JSON.stringify({
        path: 'plugins/ruflo-adr/skills/adr-review/SKILL.md',
        text: 'Review source changes against accepted Architecture Decision Records to detect violations and drift.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('ADR documentation selection must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('ADR documentation selection must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Our ADRs say one thing and the code does another; we want decision records treated as living plans and checked against reality.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationRequired: false,
    });
    expect(out.implementation).toMatchObject({
      required: false,
      verdict: 'not-required',
      proofMethod: 'lexical-documentation-card',
    });
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/living documentation/i);
    expect(answer).toMatch(/architecture decision records/i);
    expect(answer).toMatch(/implementations that match specifications/i);
    expect(out.documentationSources.length).toBeGreaterThanOrEqual(2);
  });

  it('proves an explicit query enumeration even when the generic card omits the list', async () => {
    const repo = ['memory', '-engine'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A durable memory engine with vector and graph retrieval.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        manifest: {
          path: 'package.json',
          kind: 'manifest',
          title: 'Package manifest',
          preview: 'Memory engine package.',
        },
        episodic: {
          path: 'src/episodic.ts',
          kind: 'source',
          title: 'Episodic controller',
          preview: 'Episodic memory controller.',
        },
        learning: {
          path: 'src/learning.ts',
          kind: 'source',
          title: 'Learning controller',
          preview: 'Learning controller.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'package.json',
        text: 'A single-file cognitive container with episodic memory, a causal graph, skill library, and a self-learning bandit.',
      }),
      JSON.stringify({
        path: 'src/episodic.ts',
        text: 'Implements episodic memory and causal graph relationships.',
      }),
      JSON.stringify({
        path: 'src/learning.ts',
        text: 'Implements a reusable skill library and self-learning bandit.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Explicit enumeration must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Explicit enumeration must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What are ${repo}'s core concepts — the single-file cognitive container, episodic memory, causal graph, skill library, and the self-learning bandit?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources.length).toBeGreaterThanOrEqual(2);
  });

  it('binds a two-part "What can X and Y?" capability selection to the requested abilities', async () => {
    const repo = ['quality', '-engine'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A quality engine that can generate tests and identify coverage gaps in untested code.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'docs/commands.md',
          kind: 'doc',
          title: 'Quality commands',
          preview: 'Generate tests and report coverage gaps.',
        },
        generation: {
          path: 'src/generate.ts',
          kind: 'source',
          title: 'Test generator',
          preview: 'Generate tests from source.',
        },
        coverage: {
          path: 'src/coverage.ts',
          kind: 'source',
          title: 'Coverage analyzer',
          preview: 'Find coverage gaps.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'docs/commands.md',
        text: 'The command can generate tests and identify coverage gaps.',
      }),
      JSON.stringify({
        path: 'src/generate.ts',
        text: 'export function generateTests(source) { return buildTests(source); }',
      }),
      JSON.stringify({
        path: 'src/coverage.ts',
        text: 'export function findCoverageGaps(report) { return report.uncovered; }',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Capability selection must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Capability selection must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'What can generate tests for my code and tell me which parts are untested?',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results.map((result) => result.fullText).join('\n')).toMatch(
      /generate tests[\s\S]*coverage gaps/i,
    );
  });

  it('proves both sides of a colloquial cost-quality tradeoff from implementation sources', async () => {
    const repo = ['routing', '-engine'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Routes model calls by cost while preserving an explicit answer-quality threshold.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'README.md',
          kind: 'doc',
          title: 'Cost-optimal routing',
          preview: 'Select the cheapest model predicted to clear a quality bar.',
        },
        router: {
          path: 'src/router.ts',
          kind: 'source',
          title: 'Cost-optimal router',
          preview: 'Ranks model candidates by cost and rejects candidates below qualityBar.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'README.md',
        text: 'The router selects the cheapest model predicted to clear a quality bar.',
      }),
      JSON.stringify({
        path: 'src/router.ts',
        text: 'return models.filter((model) => model.quality >= qualityBar).sort(byModelCost)[0];',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Tradeoff proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Tradeoff proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'How do I spend less money on model calls without getting dumber answers?',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results.map((result) => result.fullText).join('\n')).toMatch(
      /cheapest model[\s\S]*quality bar/i,
    );
    expect(out.implementation.implementationSources).toContain(`${repo}/src/router.ts`);
  });

  it('proves cheap-first failure escalation from the executable harness router', async () => {
    const repo = ['meta', 'harness'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## agent-harness-generator',
      `Also called ${repo} — a factory for benchmarked and evolvable agent harnesses.`,
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'repo-aliases.json'), JSON.stringify({
      'agent-harness-generator': [repo],
    }));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        router: {
          path: 'packages/projects/src/router.ts',
          kind: 'source',
          title: 'Escalation router',
          preview: `${repo} cheap model handles bulk work; verification failure escalates to frontier.`,
        },
        test: {
          path: 'packages/projects/src/router.test.ts',
          kind: 'source',
          title: 'Escalation router tests',
          preview: `${repo} cheap model failure must escalate to the frontier model.`,
        },
        quality: {
          path: 'packages/router/src/index.ts',
          kind: 'source',
          title: 'Cost-optimal quality router',
          preview: 'Pick the cheapest model predicted to clear the configured quality bar.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'packages/projects/src/router.ts',
        text: `${repo} cheap models handle bulk work. On verify failure the task escalates to a frontier model.`,
      }),
      JSON.stringify({
        path: 'packages/projects/src/router.test.ts',
        text: `${repo}: it('cheap model fail escalates', () => expect(result.escalated).toBe(true));`,
      }),
      JSON.stringify({
        path: 'packages/router/src/index.ts',
        text: 'The router picks the cheapest model whose predicted quality clears the quality bar.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Escalation proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Escalation proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Send easy tasks to a cheap model and only pay for the expensive one when the cheap one gives up.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.repos).toEqual([repo]);
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/cheap model/i);
    expect(answer).toMatch(/failure[\s\S]{0,60}escalat/i);
    expect(answer).toMatch(/quality bar/i);

    const measured = await searchAll({
      dir: d,
      query: 'Route the easy 80% of tickets to a cheap model and escalate only the ones it demonstrably fails.',
    });
    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(measured.results.map((result) => result.fullText).join('\n')).toMatch(
      /cheap model[\s\S]*quality bar/i,
    );
  });

  it('proves a prebuilt role catalog and its executable spawn surface', async () => {
    const repo = ['agentic', 'flow'].join('-');
    const d = mkdirWith([`${repo}.rvf`, 'ruflo.rvf', 'concepts.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Ready-to-run specialized agents include coder, reviewer, and architect roles in an agent swarm.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        roles: {
          path: 'src/AgentTypes.ts',
          kind: 'source',
          title: 'Prebuilt role catalog',
          preview: 'Ready-to-run specialized agents: coder, reviewer, and system-architect.',
        },
        spawn: {
          path: 'src/spawn.ts',
          kind: 'source',
          title: 'Agent spawn tool',
          preview: 'agent_spawn creates a new agent in the swarm.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/AgentTypes.ts',
        text: 'The prebuilt role catalog contains coder, reviewer, and system-architect agents.',
      }),
      JSON.stringify({
        path: 'src/spawn.ts',
        text: "description: 'Spawn a new agent in the swarm'; execute({ type }) starts the selected role.",
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Role proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Role proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Prebuilt agent roles — coder, reviewer, architect — I can spawn without writing prompts.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.repos).toEqual([repo]);
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/coder[\s\S]*reviewer[\s\S]*architect/i);
    expect(answer).toMatch(/spawn[\s\S]{0,40}agent[\s\S]{0,40}swarm/i);
  });

  it('proves replayable promotion lineage and rollback from separate implementation surfaces', async () => {
    const repo = ['meta', 'harness'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## agent-harness-generator',
      `Also called ${repo}; evolves harness policies behind benchmark and safety gates.`,
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'repo-aliases.json'), JSON.stringify({
      'agent-harness-generator': [repo],
    }));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        lineage: {
          path: 'packages/flywheel/src/lineage.ts',
          kind: 'source',
          title: 'Promotion lineage',
          preview: 'Flywheel lineage implementation with parent-linked promotion commits.',
        },
        rollback: {
          path: 'packages/jujutsu/src/bridge/adapters/memory-provider.ts',
          kind: 'source',
          title: 'Rollback adapter',
          preview: 'Checkpoint and rollback implementation for harness state.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'packages/flywheel/src/lineage.ts',
        text: 'Every promotion is a parent-linked commit with a full, receipt-backed history.',
      }),
      JSON.stringify({
        path: 'packages/jujutsu/src/bridge/adapters/memory-provider.ts',
        text: 'async rollback(handle, checkpointId) restores the harness state checkpoint.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Promotion proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Promotion proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Self-improvement where every promotion has replayable evidence and can be rolled back.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.repos).toEqual([repo]);
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/receipt-backed/i);
    expect(answer).toMatch(/rollback/i);
  });

  it('proves a specialized agent fleet and its shared state from distinct implementation surfaces', async () => {
    const repo = ['swarm', '-runtime'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Runs specialized coding agents as a coordinated fleet with shared state and memory.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        manifest: {
          path: 'package.json',
          kind: 'manifest',
          title: 'Swarm runtime package',
          preview: 'Deploy specialized agents in coordinated swarms.',
        },
        state: {
          path: 'src/shared-state.ts',
          kind: 'source',
          title: 'Shared state',
          preview: 'Central shared state for coding-agent coordination.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'package.json',
        text: '{"description":"Deploy specialized agents in coordinated swarms"}',
      }),
      JSON.stringify({
        path: 'src/shared-state.ts',
        text: 'export class SharedState { synchronize(agentId, value) {} }',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Fleet proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Fleet proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Run a fleet of specialized coding agents that share state while they work.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/specialized agents/i);
    expect(answer).toMatch(/shared\s*state/i);
    expect(out.implementation.implementationSources).toEqual(expect.arrayContaining([
      `${repo}/package.json`,
      `${repo}/src/shared-state.ts`,
    ]));
  });

  it('proves meaning-preserving prompt compression with implementation and documentation', async () => {
    const repo = ['prompt', '-compressor'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Prompt compression and token reduction for system instructions.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'README.md',
          kind: 'doc',
          title: 'Semantic compression',
          preview: 'Prompt compression maintains the full meaning despite significant size reduction.',
        },
        compressor: {
          path: 'src/compress.ts',
          kind: 'source',
          title: 'Prompt compressor',
          preview: 'Compress prompts with a registered semantic compressor.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'README.md',
        text: 'Prompt compression reduces size while preserving meaning.',
      }),
      JSON.stringify({
        path: 'src/compress.ts',
        text: 'export const compressPrompt = (prompt) => registry.compress(prompt);',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Compression proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Compression proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Shrink my system prompts without losing their meaning.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/prompt compression/i);
    expect(answer).toMatch(/preserving meaning/i);
    expect(out.implementation.implementationSources).toContain(`${repo}/src/compress.ts`);
    expect(out.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', evidenceClass: 'documentation' }),
    ]));
  });

  it('answers a plain-language specification-to-completion request with phases and quality gates', async () => {
    const repo = ['method', '-engine'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A structured methodology with Specification, Pseudocode, Architecture, Refinement, and Completion, plus a quality gate between stages.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'README.md',
          kind: 'doc',
          title: 'Method guide',
          preview: 'Five phases: Specification, Pseudocode, Architecture, Refinement, and Completion.',
        },
        manifest: {
          path: 'ui/package.json',
          kind: 'manifest',
          title: 'Method UI package',
          preview: 'UI for Specification, Pseudocode, Architecture, Refinement, and Completion.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'README.md',
        text: 'The five phases are Specification, Pseudocode, Architecture, Refinement, and Completion.',
      }),
      JSON.stringify({
        path: 'ui/package.json',
        text: '{"description":"UI for Specification, Pseudocode, Architecture, Refinement, and Completion"}',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Method proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Method proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Is there a step-by-step method that takes me from a written spec to finished code?',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results.map((result) => result.fullText).join('\n')).toMatch(
      /Specification[\s\S]*Pseudocode[\s\S]*Architecture[\s\S]*Refinement[\s\S]*Completion[\s\S]*quality gate/i,
    );
    expect(out.implementation.implementationSources).toContain(`${repo}/ui/package.json`);
  });

  it('proves a Rust neural training request while preserving the card-backed no-Python constraint', async () => {
    const repo = ['rust', '-neural'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A neural network library written in Rust that can train small neural networks without shipping Python.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        manifest: {
          path: 'Cargo.toml',
          kind: 'manifest',
          title: 'Rust neural package',
          preview: 'A pure Rust implementation of a neural-network library.',
        },
        trainer: {
          path: 'src/train.rs',
          kind: 'source',
          title: 'Neural trainer',
          preview: 'Train a neural network with an in-Rust optimizer.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'Cargo.toml',
        text: 'description = "A neural network library written in Rust"',
      }),
      JSON.stringify({
        path: 'src/train.rs',
        text: 'pub fn train(network: &mut NeuralNetwork, data: TrainingData) { optimize(network, data); }',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Rust neural proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Rust neural proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Can I train a small neural network in Rust without dragging in Python?',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results.map((result) => result.fullText).join('\n')).toMatch(
      /neural network library written in Rust[\s\S]*without shipping Python/i,
    );
    expect(out.implementation.implementationSources).toEqual(expect.arrayContaining([
      `${repo}/Cargo.toml`,
      `${repo}/src/train.rs`,
    ]));
  });

  it('proves graph queries over agent memory from two exact passages in one MCP source', async () => {
    const repo = ['memory', '-graph'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A cognitive database for persistent agent memory with causal graph relationships and queryable recall.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        server: {
          path: 'src/mcp/agentdb-mcp-server.ts',
          kind: 'source',
          title: 'Agent memory MCP server',
          preview: 'MCP implementation for agent memory tools and causal relationships.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/mcp/agentdb-mcp-server.ts',
        text: "{ name: 'causal_query', description: 'Query causal effects to understand outcomes' }",
      }),
      JSON.stringify({
        path: 'src/mcp/agentdb-mcp-server.ts',
        text: "{ name: 'causal_traverse', description: 'Walk the causal graph between two memories.' }",
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Exact graph-memory proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Exact graph-memory proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `Does ${repo} support graph queries over agent memory?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].path).toBe('src/mcp/agentdb-mcp-server.ts');
    expect(out.results[0].fullText).toContain('causal graph between two memories');
  });

  it('does not combine graph-query and memory claims from different source files', async () => {
    const repo = ['split', '-memory-graph'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A cognitive database for persistent agent memory with causal graph relationships and queryable recall.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        server: {
          path: 'src/mcp/agentdb-mcp-server.ts',
          kind: 'source',
          title: 'Causal query server',
          preview: 'Implements causal query operations.',
        },
        memory: {
          path: 'src/memory.ts',
          kind: 'source',
          title: 'Memory graph',
          preview: 'Stores graph-connected memories.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/mcp/agentdb-mcp-server.ts',
        text: "{ name: 'causal_query', description: 'Query causal effects to understand outcomes' }",
      }),
      JSON.stringify({
        path: 'src/memory.ts',
        text: 'Walk the causal graph between two memories.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockResolvedValue([hit()]);

    await searchAll({
      dir: d,
      query: `Does ${repo} support graph queries over agent memory?`,
    });

    expect(searchKb).toHaveBeenCalled();
  });

  it('grounds a core-concept inventory in the product card and corroborating source surfaces', async () => {
    const repo = ['lake', '-engine'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Core concepts are witness-anchored bundles, a RaBitQ 1-bit cache, BackendAdapter federation, WiFi-DensePose pose estimation, and Fresh, Eventual, and Frozen freshness modes.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        cache: {
          path: 'src/cache.rs',
          kind: 'source',
          title: 'Witnessed RaBitQ cache',
          preview: 'RaBitQ compressed cache keyed by each bundle witness.',
        },
        backend: {
          path: 'src/backend.rs',
          kind: 'source',
          title: 'BackendAdapter federation',
          preview: 'BackendAdapter trait for federated backend search.',
        },
        architecture: {
          path: 'docs/adr/003-pose.md',
          kind: 'adr',
          title: 'Pose architecture',
          preview: 'Accepted architecture for pose estimation.',
        },
        guide: {
          path: 'USERGUIDE.md',
          kind: 'tutorial',
          title: 'User guide',
          preview: 'The deep product reference; later sections describe the trust model.',
        },
        unrelated: {
          path: 'src/logging.rs',
          kind: 'source',
          title: 'Logging',
          preview: 'Writes debug messages.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/cache.rs',
        text: 'pub struct VectorCache { /* RaBitQ 1-bit cache */ }',
      }),
      JSON.stringify({
        path: 'src/backend.rs',
        text: 'pub trait BackendAdapter { /* BackendAdapter federation */ }',
      }),
      JSON.stringify({
        path: 'docs/adr/003-pose.md',
        text: 'Accepted: WiFi-DensePose pose estimation is the product pose architecture.',
      }),
      JSON.stringify({
        path: 'USERGUIDE.md',
        text: 'Introductory material intentionally does not repeat the concept inventory.',
      }),
      JSON.stringify({
        path: 'USERGUIDE.md',
        text: 'Later reference: witness-anchored bundles support Fresh, Eventual, and Frozen freshness modes.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Concept inventory must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Concept inventory must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `What are ${repo}'s core concepts — WAB (witness-anchored bundles), the RaBitQ 1-bit cache, BackendAdapter federation, WiFi-DensePose pose estimation, and the three freshness modes?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/cache.rs`,
      `${repo}/src/backend.rs`,
    ]));
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toContain('witness-anchored bundles');
    expect(answer).toContain('WiFi-DensePose pose estimation');
    expect(answer).toContain('Frozen freshness modes');
  });

  it('deduplicates metadata chunks before applying the bounded passage-path budget', async () => {
    const repo = ['chunked', '-inventory'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Core concepts are a witness-anchored bundle and BackendAdapter federation.',
    ].join('\n'));
    const duplicateChunks = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
      `noise-${index}`,
      {
        path: 'docs/chunked-noise.md',
        kind: 'doc',
        title: `Repeated chunk ${index}`,
        preview: 'Witness bundle overview without the exact architecture.',
      },
    ]));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        ...duplicateChunks,
        bundle: {
          path: 'src/bundle.rs',
          kind: 'source',
          title: 'Bundle implementation',
          preview: 'Core implementation.',
        },
        backend: {
          path: 'src/backend.rs',
          kind: 'source',
          title: 'Backend implementation',
          preview: 'Core implementation.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'src/bundle.rs',
        text: 'The witness-anchored bundle binds the cache state to its source.',
      }),
      JSON.stringify({
        path: 'src/backend.rs',
        text: 'The BackendAdapter federation routes across registered stores.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Duplicate chunks must not exhaust the path budget'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Duplicate chunks must not trigger cold reranking'));

    const out = await searchAll({
      dir: d,
      query: `What are ${repo}'s core concepts — a witness-anchored bundle and BackendAdapter federation?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/bundle.rs`,
      `${repo}/src/backend.rs`,
    ]));
  });

  it('answers a how-to code-example question only with both delivered example and implementation proof', async () => {
    const repo = ['learning', '-memory'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf', 'ruflo.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A self-learning vector memory engine that improves search from explicit feedback.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        guide: {
          path: 'README.md',
          kind: 'doc',
          title: 'Quick start',
          preview: 'Self-learning vector search quick start.',
        },
        backend: {
          path: 'src/LearningBackend.ts',
          kind: 'source',
          title: 'Learning backend',
          preview: 'Learning backend implementation.',
        },
        marketing: {
          path: 'docs/marketing.md',
          kind: 'doc',
          title: 'Self learning overview',
          preview: 'Self-learning vector search is fast and simple.',
        },
      },
    }));
    fs.writeFileSync(path.join(d, `${repo}.passages.jsonl`), [
      JSON.stringify({
        path: 'README.md',
        text: [
          '3 lines to self-learning search:',
          '```ts',
          'const backend = await LearningBackend.create("./memory.rvf");',
          'const results = await backend.searchAsync(query, 10);',
          'backend.recordFeedback(results[0].id, true);',
          '```',
          '### Self-Learning Vector Search',
        ].join('\n'),
      }),
      JSON.stringify({
        path: 'src/LearningBackend.ts',
        text: 'export class LearningBackend { static create(path) {} searchAsync(query, k) {} recordFeedback(id, accepted) {} }',
      }),
      JSON.stringify({
        path: 'docs/marketing.md',
        text: 'Self-learning vector search is fast and simple, with no API example.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockRejectedValue(new Error('Code example proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Code example proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: `How do I get self-learning vector search working in ${repo} in three lines of code?`,
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation).toMatchObject({
      required: true,
      verdict: 'proven',
      proofMethod: 'lexical-example-source-card',
    });
    expect(out.implementation.implementationSources).toEqual([
      `${repo}/src/LearningBackend.ts`,
    ]);
    expect(out.documentationSources).toEqual([`${repo}/README.md`]);
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toContain('LearningBackend.create');
    expect(answer).toContain('recordFeedback');
    expect(answer).toContain('Self-Learning Vector Search');
    expect(answer).not.toContain('no API example');
  });

  it('prefers a named deployed RVF family over a conflicting capability-card route', async () => {
    const d = mkdirWith([
      'testimate.rvf',
      'testimate-graphify.rvf',
      'testimate-ix.rvf',
      'ruvnet-brain.rvf',
    ]);
    fs.writeFileSync(path.join(d, 'repo-aliases.json'), JSON.stringify({
      testimate: ['testimate-graphify', 'testimate-ix'],
    }));
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## ruvnet-brain',
      'The Brain coordinates testimonial moderation workflows and architecture guidance.',
    ].join('\n'));
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({
      path: `${name}/source.md`,
      repo: name,
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands.map((candidate) => ({ ...candidate, ceScore: 7.0 })));

    const out = await searchAll({
      dir: d,
      query: 'How does Testimate handle testimonial moderation?',
    });

    expect(out.repos).toEqual(['testimate', 'testimate-graphify', 'testimate-ix']);
    expect(out.routing).toMatchObject({
      attempted: true,
      accepted: true,
      confidence: 'named',
    });
    expect(vi.mocked(searchKb).mock.calls.map(([args]) => args.name).sort()).toEqual([
      'testimate',
      'testimate-graphify',
      'testimate-ix',
    ]);
  });

  it('keeps an explicitly named repository scoped when its evidence is thin', async () => {
    const d = mkdirWith(['concepts.rvf', 'rulake.rvf', 'ruflo.rvf', 'ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## ruvector',
      'Single-file RVF vector search with HNSW and TypeScript SDK backends.',
      '## ruflo',
      'Agent orchestration and project memory.',
      '## rulake',
      'Witness-verified vector read cache.',
    ].join('\n'));
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({ path: `${name}/source.md` })]);
    let reranks = 0;
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) => {
      reranks++;
      return cands.map((candidate) => ({ ...candidate, ceScore: reranks === 1 ? 1.0 : 7.0 }));
    });

    const out = await searchAll({
      dir: d,
      query: 'What does the @ruvector/rvf TypeScript SDK expose and how is its backend resolved at runtime?',
    });
    expect(out.repos).toEqual(['ruvector']);
    expect(out.routing).toMatchObject({ attempted: true, accepted: true });
    expect(out.evidence.grade).toBe('thin');
    expect(reranks).toBe(1);
  });

  it('does not widen a RuvNet Brain product question from thin self evidence to every repo', async () => {
    const d = mkdirWith(['concepts.rvf', 'ruvnet-brain.rvf', 'ruflo.rvf', 'agentic-qe.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      '## ruvnet-brain',
      'Source-grounded Brain product with release gates and exact-artifact verification.',
      '## ruflo',
      'Agent orchestration and project memory.',
      '## agentic-qe',
      'Quality engineering test execution.',
    ].join('\n'));
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [hit({ path: `${name}/source.md`, repo: name })]);
    let reranks = 0;
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) => {
      reranks++;
      return cands.map((candidate) => ({ ...candidate, ceScore: 1.0 }));
    });

    const out = await searchAll({
      dir: d,
      query: 'How should RuvNet Brain enforce releases with Agentic QE and Ruflo receipts?',
    });
    expect(out.repos).toEqual(['ruvnet-brain']);
    expect(out.routing).toMatchObject({
      attempted: true,
      accepted: true,
      primaryProductScope: true,
    });
    expect(reranks).toBe(1);
  });

  it('lexically rescues an exact scoped-package source that dense retrieval buried', async () => {
    const d = mkdirWith(['ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'ruvector.big.passages.jsonl'), [
      JSON.stringify({
        id: 'decoy',
        path: 'docs/general.md',
        title: 'General vectors',
        text: 'General discussion of vector storage.',
      }),
      JSON.stringify({
        id: 'sdk',
        path: 'npm/packages/rvf/src/index.ts',
        title: '@ruvector/rvf',
        text: 'The @ruvector/rvf TypeScript SDK exports class RvfDatabase. Runtime backend resolution selects native N-API, WASM, or fallback.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockResolvedValue([hit({ path: 'docs/general.md', title: 'General vectors' })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands
        .map((candidate) => ({
          ...candidate,
          ceScore: candidate.fullText.includes('RvfDatabase') ? 9 : 0,
        }))
        .sort((a, b) => b.ceScore - a.ceScore));

    const out = await searchAll({
      dir: d,
      repos: ['ruvector'],
      query: 'What does the @ruvector/rvf TypeScript SDK expose and how is its backend resolved at runtime?',
    });
    expect(out.results[0]).toMatchObject({
      repo: 'ruvector',
      path: 'npm/packages/rvf/src/index.ts',
      title: '@ruvector/rvf',
      _lane: 'rescue',
    });
  });

  it('lexically rescues a named monorepo inventory survey and executable install guide', async () => {
    const d = mkdirWith(['ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'ruvector.passages.jsonl'), [
      JSON.stringify({
        id: 'decoy',
        path: 'crates/ruvector-core/fuzz/Cargo.toml',
        title: 'ruvector-core-fuzz',
        text: 'Rust crate manifest for an isolated fuzz workspace.',
      }),
      JSON.stringify({
        id: 'survey',
        path: 'docs/sdk/01-survey.md',
        title: 'What ruvector Ships Today',
        text: 'The crates directory contains about 110 directories. The Cargo workspace has 96 active members. npm packages include ruvector and @ruvector/core; core Rust crates include ruvector-core.',
      }),
      JSON.stringify({
        id: 'install',
        path: 'docs/guides/INSTALLATION.md',
        title: 'Installation Guide',
        text: 'Install the npm package with npm install ruvector. Add the Rust crate with cargo add ruvector-core. These are the workspace installation surfaces.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockResolvedValue([hit({
      path: 'crates/ruvector-core/fuzz/Cargo.toml',
      title: 'ruvector-core-fuzz',
      fullText: 'Rust crate manifest for an isolated fuzz workspace.',
    })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands
        .map((candidate) => ({
          ...candidate,
          ceScore: candidate.path === 'docs/sdk/01-survey.md'
            ? 5
            : candidate.path === 'docs/guides/INSTALLATION.md' ? 4 : 8,
        }))
        .sort((a, b) => b.ceScore - a.ceScore));

    const out = await searchAll({
      dir: d,
      repos: ['ruvector'],
      query: "What are RuVector's npm package and core crate names, and roughly how large is the Rust workspace?",
    });
    expect(out.results[0]).toMatchObject({
      repo: 'ruvector',
      path: 'docs/sdk/01-survey.md',
      _lane: 'rescue',
      inventoryBoosted: true,
    });
  });

  it('rescues a document that contains both quoted numeric performance claims', async () => {
    const d = mkdirWith(['agentdb.rvf']);
    fs.writeFileSync(path.join(d, 'agentdb.passages.jsonl'), [
      JSON.stringify({ id: 'decoy', path: 'docs/perf.md', title: 'Performance', text: 'General benchmark discussion.' }),
      JSON.stringify({
        id: 'readme',
        path: 'README.md',
        title: 'AgentDB',
        text: '150× faster than SQLite. Up to +36% search quality from feedback. Run the benchmark harness.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockResolvedValue([hit({ path: 'docs/perf.md', fullText: 'General benchmark discussion.' })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands.map((candidate) => ({ ...candidate, ceScore: candidate.path === 'README.md' ? 9 : 1 }))
        .sort((a, b) => b.ceScore - a.ceScore));
    const out = await searchAll({
      dir: d,
      repos: ['agentdb'],
      query: "How does AgentDB validate '150x faster than SQLite' and '+36% search quality from feedback'?",
    });
    expect(out.results[0]).toMatchObject({ path: 'README.md', _lane: 'rescue' });
  });

  it('rescues the exact ADR instead of a different ADR that merely cites it', async () => {
    const d = mkdirWith(['ruvector.rvf']);
    fs.writeFileSync(path.join(d, 'ruvector.passages.jsonl'), [
      JSON.stringify({ id: 'wrong', path: 'docs/adr/ADR-038.md', title: 'ADR-038: Witnesses', text: 'Related: ADR-029.' }),
      JSON.stringify({
        id: 'right',
        path: 'docs/adr/ADR-029-rvf-canonical-format.md',
        title: 'ADR-029: RVF as Canonical Binary Format',
        text: 'RVF is the canonical binary format. Supersedes ADR-001 and ADR-018.',
      }),
    ].join('\n'));
    vi.mocked(searchKb).mockResolvedValue([hit({ path: 'docs/adr/ADR-038.md', title: 'ADR-038: Witnesses' })]);
    vi.mocked(rerankPairs).mockImplementation(async (_q, cands) =>
      cands.map((candidate) => ({
        ...candidate,
        ceScore: candidate.path.includes('ADR-029-rvf') ? 9 : 3,
      })).sort((a, b) => b.ceScore - a.ceScore));
    const out = await searchAll({
      dir: d,
      repos: ['ruvector'],
      query: 'What does ADR-029 decide about RVF canonical format, and what does it supersede?',
    });
    expect(out.results[0]).toMatchObject({
      path: 'docs/adr/ADR-029-rvf-canonical-format.md',
      _lane: 'rescue',
    });
  });

  it('proves adaptive retrieval ranking and its improve-only promotion gate from separate sources', async () => {
    const repo = ['ru', 'flo'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A self-learning retrieval flywheel that adapts ranking policy from measured outcomes.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        ranking: {
          path: 'src/adaptive-ranking.ts',
          kind: 'source',
          title: 'Adaptive retrieval ranking',
          preview: 'Ranking policy weights are biased toward axes with positive historical benchmark gains.',
        },
        gate: {
          path: 'src/promotion-gate.ts',
          kind: 'source',
          title: 'Benchmark promotion gate',
          preview: 'A candidate is accepted only when its held-out score improves over the baseline and every quality gate passes.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Adaptive-ranking proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Adaptive-ranking proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: 'Retrieval that tunes its own ranking weights over time but only keeps proven improvements.',
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/adaptive-ranking.ts`,
      `${repo}/src/promotion-gate.ts`,
    ]));
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/ranking policy weights[\s\S]*positive historical benchmark gains/i);
    expect(answer).toMatch(/held-out score improves[\s\S]*baseline[\s\S]*quality gate/i);
  });

  it('proves evolvable harness policy and auditor-replayable receipts from separate sources', async () => {
    const repo = ['ru', 'flo'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'A harness learning loop that improves measured policies behind strict qualification gates.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        routing: {
          path: 'src/enhanced-model-router.ts',
          kind: 'source',
          title: 'Evolvable model routing policy',
          preview: 'Model routing policy learns from recorded outcomes and improves future routing decisions.',
        },
        replay: {
          path: 'src/harness-loop.ts',
          kind: 'source',
          title: 'Receipt-backed deterministic replay',
          preview: 'Only receipt-backed trajectories with deterministic replay qualify as promotion evidence.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('Harness-policy proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('Harness-policy proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: "We want our harness's planner and retry policies to improve week over week, with receipts an auditor could replay.",
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(new Set(out.implementation.implementationSources)).toEqual(new Set([
      `${repo}/src/enhanced-model-router.ts`,
      `${repo}/src/harness-loop.ts`,
    ]));
    const answer = out.results.map((result) => result.fullText).join('\n');
    expect(answer).toMatch(/model routing policy[\s\S]*improves/i);
    expect(answer).toMatch(/receipt-backed[\s\S]*deterministic replay/i);
  });

  it('proves an offline on-device semantic index with implementation and zero-server evidence', async () => {
    const repo = ['ru', 'vector'].join('');
    const d = mkdirWith([`${repo}.rvf`, 'concepts.rvf']);
    fs.writeFileSync(path.join(d, 'capability-cards.md'), [
      `## ${repo}`,
      'Local on-device semantic search uses an HNSW vector index with a zero-server deployment.',
    ].join('\n'));
    fs.writeFileSync(path.join(d, `${repo}.meta.json`), JSON.stringify({
      entries: {
        index: {
          path: 'src/hnsw.rs',
          kind: 'source',
          title: 'HNSW vector index',
          preview: 'HNSW approximate nearest-neighbor search indexes local vectors.',
        },
        deployment: {
          path: 'docs/on-device.md',
          kind: 'doc',
          title: 'On-device deployment',
          preview: 'Run semantic search on-device with zero server round-trips.',
        },
      },
    }));
    vi.mocked(searchKb).mockRejectedValue(new Error('On-device index proof must not load the cold embedder'));
    vi.mocked(rerankPairs).mockRejectedValue(new Error('On-device index proof must not load the cold reranker'));

    const out = await searchAll({
      dir: d,
      query: "We're building an offline-first field app that must semantically search 100k manuals with zero server round-trips. What's the on-device index?",
    });

    expect(searchKb).not.toHaveBeenCalled();
    expect(rerankPairs).not.toHaveBeenCalled();
    expect(out.routing).toMatchObject({
      accepted: true,
      lane: 'source-backed-card',
      implementationVerdict: 'proven',
    });
    expect(out.implementation.implementationSources).toEqual([`${repo}/src/hnsw.rs`]);
    expect(out.results.map((result) => result.fullText).join('\n')).toMatch(
      /HNSW[\s\S]*local vectors[\s\S]*zero server round-trips/i,
    );
  });
});
