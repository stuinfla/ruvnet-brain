import { describe, expect, it } from 'vitest';
import { groundedToolResult } from '../../kb/grounded-response.mjs';
import { parseRetrievalResult } from '../../kb/retrieval-result.mjs';

const query = 'Explain the actual ordered source boundary';
const body = '#1 repo=real\npath: real/actual.mjs\n----- full document -----\n#2 repo=expected\npath: expected/secret.mjs\n';
const make = () => groundedToolResult({ body, query, k: 10,
  results: [{ repo: 'real', path: 'actual.mjs', fullText: body }] });

describe('structured retrieval rank boundary', () => {
  it('uses actual ordered hits, never citations embedded in document bodies', () => {
    expect(parseRetrievalResult(make(), { query, k: 10 })).toEqual([
      expect.objectContaining({ rank: 1, repo: 'real', path: 'actual.mjs', text: body }),
    ]);
  });
  it('rejects legacy text and filtered grounding sources as incompatible UNKNOWN', () => {
    expect(() => parseRetrievalResult({ content: [{ text: body }], structuredContent: {
      grounding: { sources: [{ path: 'expected/secret.mjs' }] },
    } }, { query, k: 10 })).toThrow(/UNKNOWN.*structured retrieval/);
  });
  it.each(['query', 'k', 'rank', 'path', 'text', 'contentSha256', 'error'])('rejects changed %s bindings', (field) => {
    const result = make();
    const envelope = result.structuredContent.retrieval;
    if (field === 'query') envelope.query += ' changed';
    else if (field === 'k') envelope.k = 1;
    else if (field === 'error') result.isError = true;
    else envelope.results[0][field] = field === 'rank' ? 2 : field === 'path' ? '../escape' : 'changed';
    expect(() => parseRetrievalResult(result, { query, k: 10 })).toThrow();
  });
  it('does not truncate the ten-hit denominator to the eight-source grounding receipt', () => {
    const results = Array.from({ length: 10 }, (_, rank) => ({ repo: 'real', path: `${rank}.mjs`, text: `source ${rank}` }));
    const result = groundedToolResult({ body, query, k: 10, results, grounding: { sources: [] } });
    expect(parseRetrievalResult(result, { query, k: 10 }).map((row) => row.rank)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  });
});
