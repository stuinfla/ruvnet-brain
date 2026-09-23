import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/forge-rerank.mjs', () => ({ rerankPairs: vi.fn() }));

import { searchAll } from '../../kb/forge-ask-all.mjs';
import { searchKb } from '../../kb/forge-ask.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';

describe('natural project scopes', () => {
  it('does not widen a named repository when its identifiers occur in other stores', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scope-'));
    for (const repo of ['ruvnet-brain', 'agentdb', 'agentic-flow']) {
      fs.writeFileSync(path.join(dir, `${repo}.rvf`), 'fixture');
    }
    for (const repo of ['agentdb', 'agentic-flow']) {
      fs.writeFileSync(path.join(dir, `${repo}.passages.jsonl`), `${JSON.stringify({
        id: '1', path: 'docs/brain.md', title: 'RuvNet Brain integration', text: 'RuvNet Brain release details.',
      })}\n`);
    }
    vi.mocked(searchKb).mockImplementation(async ({ name }) => [{
      repo: name, path: `${name}/README.md`, title: name, fullText: 'RuvNet Brain release details.', bestDistance: 0.1,
    }]);
    vi.mocked(rerankPairs).mockImplementation(async (_query, rows) =>
      rows.map((row) => ({ ...row, ceScore: 1 })));

    const result = await searchAll({
      dir,
      query: 'In the ruvnet-brain repository, how does RuvNet Brain prove a public release artifact?',
      allowFullCorpus: false,
    });

    expect(result.repos).toEqual(['ruvnet-brain']);
    expect(searchKb.mock.calls.map(([args]) => args.name)).toEqual(['ruvnet-brain']);
  });
});
