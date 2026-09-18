import { describe, expect, it } from 'vitest';
import { groundedToolResult } from '../../kb/grounded-response.mjs';
import { collapseIdenticalResults, parseRetrievalResult } from '../../kb/retrieval-result.mjs';

const query = 'Explain the actual ordered source boundary';
const body = '#1 repo=real\npath: real/actual.mjs\n----- full document -----\n#2 repo=expected\npath: expected/secret.mjs\n';
const make = () => groundedToolResult({ body, query, k: 10,
  results: [{ repo: 'real', path: 'actual.mjs', fullText: body }] });

describe('structured retrieval rank boundary', () => {
  it('retains alternate source paths when identical passages are collapsed', () => {
    const original = [
      { repo: 'real', path: 'README.md', fullText: 'same text', ceScore: 8 },
      { repo: 'real', path: 'mirror/README.md', fullText: 'same text', ceScore: 7 },
      { repo: 'real', path: 'guide.md', fullText: 'distinct answer', ceScore: 6 },
    ];
    const before = JSON.stringify(original);
    const results = collapseIdenticalResults(original);
    expect(results.map(row => row.path)).toEqual(['README.md', 'guide.md']);
    const response = groundedToolResult({ body, query, k: 2, results });
    expect(parseRetrievalResult(response, { query, k: 2 })[0]).toMatchObject({
      path: 'README.md', alternativePaths: ['mirror/README.md'], text: 'same text',
    });
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps repository, implementation, and truncated evidence distinct', () => {
    const results = collapseIdenticalResults([
      { repo: 'real', path: 'README.md', fullText: 'identical' },
      { repo: 'other', path: 'README.md', fullText: 'identical' },
      { repo: 'real', path: 'source.mjs', fullText: 'identical' },
      { repo: 'real', path: 'partial.md', fullText: 'identical', truncated: true },
      { repo: 'real', path: 'other.md', fullText: 'identical\n' },
    ]);
    expect(results).toHaveLength(5);
  });

  it('keeps different concept owners separate and prevents invalid low-ranked paths poisoning top-k', () => {
    expect(collapseIdenticalResults(['alpha/primer.md', 'beta/primer.md'].map(path => ({
      repo: 'concepts', path, text: 'same primer',
    })))).toHaveLength(2);
    const results = collapseIdenticalResults([
      { repo: 'real', path: 'README.md', text: 'same text' },
      { repo: 'real', path: '../bad.md', text: 'same text' },
      { repo: 'real', text: 'same text' },
    ]);
    expect(results).toHaveLength(3);
    expect(() => groundedToolResult({ body, query, k: 1, results })).not.toThrow();
  });

  it.each([['../escape'], ['/absolute'], ['C:escape.md'], ['actual.mjs'], ['mirror.md', 'mirror.md'], 'mirror.md'].map(alternativePaths => ({ alternativePaths })))
    ('rejects unsafe or ambiguous alternate source paths $alternativePaths', ({ alternativePaths }) => {
      const result = make();
      result.structuredContent.retrieval.results[0].alternativePaths = alternativePaths;
      expect(() => parseRetrievalResult(result, { query, k: 10 })).toThrow(/alternative source/);
    });

  it('bounds duplicate path disclosure and reports the omitted count', () => {
    const results = collapseIdenticalResults(Array.from({ length: 100 }, (_, i) => ({
      repo: 'real', path: `copy-${i}.md`, text: 'same text',
    })));
    expect(results).toHaveLength(1);
    const response = groundedToolResult({ body, query, k: 1, results });
    const [row] = parseRetrievalResult(response, { query, k: 1 });
    expect(row.alternativePaths).toHaveLength(32);
    expect(row.omittedAlternativePaths).toBe(67);
  });
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
