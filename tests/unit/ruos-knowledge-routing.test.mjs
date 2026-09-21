import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeReposFromCards } from '../../kb/card-lane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const kb = path.join(root, 'kb');
const stores = ['ruos', 'cognitum-ruos', 'ruos-macair', 'ruflo', 'ruvector'];
const temporary = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe('public ruOS knowledge discovery', () => {
  it.each([
    ['What is ruOS?', 'ruos'],
    ['What is cognitum-ruos?', 'cognitum-ruos'],
    ['What are cognitum-ruos workstation health capabilities?', 'cognitum-ruos'],
    ['Which agentic Linux workstation OS supports local reasoning and GPU profiles?', 'cognitum-ruos'],
  ])('routes %s to its source store', (query, expected) => {
    expect(routeReposFromCards(query, kb, stores).repos[0]).toBe(expected);
  });

  it('does not claim the requested repository is routable when its store is absent', () => {
    const result = routeReposFromCards('What is cognitum-ruos?', kb, ['ruos-macair']);
    expect(result.repos).not.toContain('cognitum-ruos');
  });

  it('preserves named-store routing when the two ruOS cards are removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruos-card-regression-'));
    temporary.push(dir);
    const cards = fs.readFileSync(path.join(kb, 'capability-cards.md'), 'utf8')
      .replace(/\n## (?:cognitum-ruos|ruos)\n[\s\S]*?(?=\n## |$)/g, '');
    fs.writeFileSync(path.join(dir, 'capability-cards.md'), cards);
    expect(routeReposFromCards('What is ruOS?', dir, stores).repos).toEqual([]);
    expect(routeReposFromCards('What is cognitum-ruos?', dir, stores).repos).toEqual(['cognitum-ruos']);
  });

  it('routes an explicitly named installed Cognitum store when it has no capability card', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruos-missing-card-'));
    temporary.push(dir);
    const cards = fs.readFileSync(path.join(kb, 'capability-cards.md'), 'utf8')
      .replace(/\n## cognitum-ruos\n[\s\S]*?(?=\n## |$)/g, '');
    fs.writeFileSync(path.join(dir, 'capability-cards.md'), cards);
    fs.copyFileSync(path.join(kb, 'repo-aliases.json'), path.join(dir, 'repo-aliases.json'));

    const named = routeReposFromCards('What is cognitum ruOS?', dir, stores);
    expect(named.repos).toEqual(['cognitum-ruos']);
    expect(named.cardRepos).not.toHaveProperty('cognitum-ruos');
    expect(named.confidence).toBe('named');
    expect(routeReposFromCards('What is ruOS?', dir, stores).repos).toEqual(['ruos']);
    expect(routeReposFromCards('How do I center a div?', dir, stores).repos).toEqual([]);
  });

  it('keeps an explicit no-card source scope from inheriting an unrelated card owner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-card-scope-'));
    temporary.push(dir);
    fs.writeFileSync(path.join(dir, 'capability-cards.md'),
      '## ruflo\nAgents share learned patterns across projects through memory APIs.\n');
    const route = routeReposFromCards(
      'Within missing-card only, how can agents share learned patterns across projects?',
      dir,
      ['missing-card', 'ruflo'],
    );
    expect(route.repos).toEqual(['missing-card']);
    expect(route.namedRepos).toEqual(['missing-card']);
    expect(route.cardRepos).not.toHaveProperty('missing-card');
  });
});
