// tests/unit/public-inputs.test.mjs — Step 3 (2026-09-13): materializePublicInputs is the ONE
// canonical public-prose selection pipeline (scripts/public-inputs.mjs), replacing three
// independent, disagreeing transformations (build-concepts.mjs, corpus-aggregates.mjs's
// buildConceptAggregate, build-bundle.mjs) and corpus-reconcile.mjs's syncCorpusInputs overlay.
//
// Four properties are proven here, verbatim from the Dual multi-model adversarial review's spec:
//   1. Private fixtures (named in the private fence) are excluded from the public tree.
//   2. Ambiguous topic ownership (two inputs claiming the same slug) FAILS explicitly.
//   3. A deleted seed input disappears from a fresh run rather than lingering via overlay.
//   4. (tests/integration/public-inputs-packaging.test.mjs) every file concepts.sources.json names
//      survives packaging with IDENTICAL bytes.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materializePublicInputs, resolveTopicOwnership } from '../../scripts/public-inputs.mjs';

const temps = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-inputs-test-'));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

/** A minimal builderRoot/kb fixture: N repos, each with a primer, optional topics, optional L2. */
function makeBuilderRoot({ privateStores = [], repos = {}, cards = [], aliases = null } = {}) {
  const root = temp();
  const kb = path.join(root, 'kb');
  fs.mkdirSync(path.join(kb, 'l2'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores }));
  for (const [repo, spec] of Object.entries(repos)) {
    fs.writeFileSync(path.join(kb, `${repo}-primer.md`), spec.primer ?? `# ${repo} primer\n\nbody text for ${repo}.`);
    if (spec.topics) fs.writeFileSync(path.join(kb, `l2-topics.${repo}.json`), JSON.stringify(spec.topics));
    for (const [slug, body] of Object.entries(spec.l2 || {})) {
      fs.writeFileSync(path.join(kb, 'l2', `${slug}.md`), body);
    }
  }
  if (cards.length) {
    fs.writeFileSync(path.join(kb, 'capability-cards.md'),
      cards.map(({ repo, text }) => `## ${repo}\n${text}\n`).join('\n'));
  }
  if (aliases) fs.writeFileSync(path.join(kb, 'repo-aliases.json'), JSON.stringify(aliases));
  return root;
}

describe('materializePublicInputs — property 1: private fixtures are excluded', () => {
  it('excludes a private repo\'s primer, topics file, and L2 article from the public tree', () => {
    const root = makeBuilderRoot({
      privateStores: ['sample-private-repo'],
      repos: {
        'sample-private-repo': { topics: [{ slug: 'private-architecture' }], l2: { 'private-architecture': '# Private Architecture\nsecret body' } },
        'sample-public-repo': { topics: [{ slug: 'public-indexing' }], l2: { 'public-indexing': '# Public Indexing\npublic body' } },
      },
    });
    const out = path.join(temp(), 'assets');
    const result = materializePublicInputs({ builderRoot: root, outDir: out });

    expect(fs.existsSync(path.join(out, 'sample-private-repo-primer.md'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'l2-topics.sample-private-repo.json'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'l2', 'private-architecture.md'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'sample-public-repo-primer.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'l2', 'public-indexing.md'))).toBe(true);

    // The exclusion evidence proves WHAT was excluded (by digest), never the content itself.
    expect(result.selectionReceipt.excluded.primers).toEqual([
      { repo: 'sample-private-repo', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) },
    ]);
    expect(result.selectionReceipt.excluded.l2).toEqual([
      { slug: 'private-architecture', repo: 'sample-private-repo', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) },
    ]);
    expect(JSON.stringify(result.selectionReceipt)).not.toContain('secret body');
  });

  it('fences a private-owned L2 article even when its repo attribution is unattributed/public (QE-0011 shape)', () => {
    const root = makeBuilderRoot({
      privateStores: ['sample-private-repo'],
      repos: { 'sample-private-repo': { topics: [{ slug: 'private-architecture' }] } },
    });
    // The L2 article file itself carries NO repo attribution, so ownership defaults to 'ruvnet'
    // (a PUBLIC name) unless the slug fence catches it.
    fs.writeFileSync(path.join(root, 'kb', 'l2', 'private-architecture.md'), '# Private Architecture\nsecret body');
    const out = path.join(temp(), 'assets');
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'l2', 'private-architecture.md'))).toBe(false);
  });

  it('excludes a private repo\'s capability-cards.md section', () => {
    const root = makeBuilderRoot({
      privateStores: ['sample-private-repo'],
      repos: { 'sample-private-repo': {}, 'sample-public-repo': {} },
      cards: [{ repo: 'sample-private-repo', text: 'secret capability' }, { repo: 'sample-public-repo', text: 'public capability' }],
    });
    const out = path.join(temp(), 'assets');
    const result = materializePublicInputs({ builderRoot: root, outDir: out });
    const shipped = fs.readFileSync(path.join(out, 'capability-cards.md'), 'utf8');
    expect(shipped).not.toContain('secret capability');
    expect(shipped).toContain('public capability');
    expect(result.selectionReceipt.excluded.cards.map((c) => c.repo)).toEqual(['sample-private-repo']);
  });
});

describe('materializePublicInputs — property 2: ambiguous topic ownership FAILS explicitly', () => {
  it('throws when two different repos both claim the same slug', () => {
    const root = makeBuilderRoot({
      repos: {
        'repo-alpha': { topics: [{ slug: 'shared-topic' }] },
        'repo-beta': { topics: [{ slug: 'shared-topic' }] },
      },
    });
    const out = path.join(temp(), 'assets');
    expect(() => materializePublicInputs({ builderRoot: root, outDir: out }))
      .toThrow(/conflicting topic ownership.*"shared-topic".*claimed by both/i);
  });

  it('does NOT throw when the same repo declares the same slug twice (not a conflict)', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': { topics: [{ slug: 'x' }, { slug: 'x' }] } } });
    expect(() => resolveTopicOwnership(path.join(root, 'kb'), ['repo-alpha'])).not.toThrow();
  });

  it('a repo re-declaring a legacy SEED_OWNERSHIP slug is fine; a DIFFERENT repo claiming it is a conflict', () => {
    const rootOk = makeBuilderRoot({ repos: { ruflo: { topics: [{ slug: 'adr-coverage' }] } } });
    expect(() => resolveTopicOwnership(path.join(rootOk, 'kb'), ['ruflo'])).not.toThrow();

    const rootConflict = makeBuilderRoot({ repos: { 'repo-gamma': { topics: [{ slug: 'adr-coverage' }] } } });
    expect(() => resolveTopicOwnership(path.join(rootConflict, 'kb'), ['repo-gamma']))
      .toThrow(/conflicting topic ownership.*"adr-coverage".*"ruflo".*"repo-gamma"/i);
  });

  it('does not silently pick a winner by iteration order -- the SAME conflicting inputs fail regardless of repo name sort order', () => {
    const rootAB = makeBuilderRoot({ repos: { 'repo-alpha': { topics: [{ slug: 'x' }] }, 'repo-zeta': { topics: [{ slug: 'x' }] } } });
    const rootBA = makeBuilderRoot({ repos: { 'repo-zeta': { topics: [{ slug: 'x' }] }, 'repo-alpha': { topics: [{ slug: 'x' }] } } });
    expect(() => resolveTopicOwnership(path.join(rootAB, 'kb'), ['repo-alpha', 'repo-zeta'])).toThrow(/conflicting topic ownership/i);
    expect(() => resolveTopicOwnership(path.join(rootBA, 'kb'), ['repo-zeta', 'repo-alpha'])).toThrow(/conflicting topic ownership/i);
  });
});

describe('materializePublicInputs — property 3: a deleted seed input disappears (no overlay)', () => {
  it('removes a primer whose source repo disappeared from the checkout between rounds', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': {}, 'repo-beta': {} } });
    const out = path.join(temp(), 'assets');
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'repo-alpha-primer.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'repo-beta-primer.md'))).toBe(true);

    fs.rmSync(path.join(root, 'kb', 'repo-alpha-primer.md'));
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'repo-alpha-primer.md'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'repo-beta-primer.md'))).toBe(true);
  });

  it('removes an l2-topics.<repo>.json whose repo no longer declares one', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': { topics: [{ slug: 'x' }] } } });
    const out = path.join(temp(), 'assets');
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'l2-topics.repo-alpha.json'))).toBe(true);

    fs.rmSync(path.join(root, 'kb', 'l2-topics.repo-alpha.json'));
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'l2-topics.repo-alpha.json'))).toBe(false);
  });

  it('removes an L2 article deleted from the checkout, via the fresh l2/ swap', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': { l2: { 'topic-a': '# Topic A\nbody' } } } });
    const out = path.join(temp(), 'assets');
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'l2', 'topic-a.md'))).toBe(true);

    fs.rmSync(path.join(root, 'kb', 'l2', 'topic-a.md'));
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'l2', 'topic-a.md'))).toBe(false);
  });

  it('removes a repo that went private between rounds, not just one that disappeared', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': {} } });
    const out = path.join(temp(), 'assets');
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'repo-alpha-primer.md'))).toBe(true);

    fs.writeFileSync(path.join(root, 'kb', 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['repo-alpha'] }));
    materializePublicInputs({ builderRoot: root, outDir: out });
    expect(fs.existsSync(path.join(out, 'repo-alpha-primer.md'))).toBe(false);
  });
});

describe('materializePublicInputs — self-materialization safety', () => {
  it('is safe to call with outDir pointing at builderRoot\'s own kb/ (a plain local run)', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': { l2: { 'topic-a': '# Topic A\nbody' } } } });
    const kb = path.join(root, 'kb');
    const before = fs.readFileSync(path.join(kb, 'l2', 'topic-a.md'), 'utf8');
    const result = materializePublicInputs({ builderRoot: root, outDir: kb });
    expect(fs.readFileSync(path.join(kb, 'l2', 'topic-a.md'), 'utf8')).toBe(before);
    expect(result.included.l2).toEqual(['topic-a']);
  });
});

describe('materializePublicInputs — builder identity + fail-closed fence', () => {
  it('rejects a malformed builderSha', () => {
    const root = makeBuilderRoot({ repos: { 'repo-alpha': {} } });
    expect(() => materializePublicInputs({ builderRoot: root, outDir: path.join(temp(), 'a'), builderSha: 'not-a-sha' }))
      .toThrow(/builderSha must be an exact 40-character/i);
  });

  it('FAILS CLOSED when PRIVATE-STORES.json is missing (no allowNoFence)', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    expect(() => materializePublicInputs({ builderRoot: root, outDir: path.join(temp(), 'a') }))
      .toThrow(/private fence missing/i);
  });
});
