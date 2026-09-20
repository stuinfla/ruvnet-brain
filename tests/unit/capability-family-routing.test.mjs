import { describe, expect, it } from 'vitest';
import { routeReposFromCards } from '../../kb/card-lane.mjs';
import { routeCapabilityFamily } from '../../kb/capability-families.mjs';

const KB = new URL('../../kb/', import.meta.url).pathname;
const STORES = ['ruvector', 'ruflo', 'codex-one', 'agentdb'];

describe('capability-family matching stays separate from baseline source routing', () => {
  it('keeps baseline card-owner selection for ordinary-language local vector storage', () => {
    expect(routeReposFromCards(
      'What is the best way to store and search embeddings on disk locally and privately?',
      KB,
      STORES,
    )).toMatchObject({ repos: ['ruvector'], confidence: 'described' });
  });

  it.each([
    'How should I store embeddings in this project without running a server?',
    'Can I keep vector data offline on this device and still search it?',
    'Where can I persist private embeddings locally for similarity lookup?',
  ])('keeps the existing card route for a local-persistence paraphrase: %s', (query) => {
    expect(routeReposFromCards(query, KB, STORES))
      .toMatchObject({ repos: ['ruvector'], confidence: 'described' });
  });

  it('does not replace the baseline cross-project owner with the Ruflo family guess', () => {
    const baseline = routeReposFromCards(
      'How can agents carry useful learning from one project to another?',
      KB,
      STORES,
    );
    expect(baseline).toMatchObject({ repos: ['codex-one'], confidence: 'described' });
    expect(routeCapabilityFamily('How can agents carry useful learning from one project to another?', STORES))
      .toMatchObject({ repos: ['ruflo'], confidence: 'capability-family' });
  });

  it.each([
    'How do I reuse an agent experience in a different repository?',
    'Can learned patterns move between separate projects?',
    'How can assistants share reusable knowledge across codebases?',
  ])('routes an independent cross-project learning paraphrase: %s', (query) => {
    expect(routeCapabilityFamily(query, STORES))
      .toMatchObject({ repos: ['ruflo'], confidence: 'capability-family' });
  });

  it('leaves explicit owner names to the named-product route', () => {
    expect(routeReposFromCards(
      'How does Ruflo use IPFS to share learned patterns across projects?',
      KB,
      STORES,
    )).toMatchObject({ repos: ['ruflo'], confidence: 'named' });
  });

  it('does not widen unrelated prose from a partial capability match', () => {
    expect(routeReposFromCards('How can an app be private?', KB, STORES).repos).toEqual([]);
  });

  it('does not route storage or learning language without the required deployment/boundary', () => {
    expect(routeCapabilityFamily('How can I store embeddings?', STORES)).toBeNull();
    expect(routeCapabilityFamily('How can agents learn patterns in this project?', STORES)).toBeNull();
  });

  it('declines a query that matches two different capability families', () => {
    expect(routeCapabilityFamily(
      'How do agents transfer learned patterns between projects while storing private vectors offline?',
      STORES,
    )).toBeNull();
  });
});
