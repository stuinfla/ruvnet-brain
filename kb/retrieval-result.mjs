import crypto from 'node:crypto';
import path from 'node:path';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const safePath = (value) => typeof value === 'string' && value.length > 0
  && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
  && !value.split(/[\\/]/).includes('..');

// Independent of grounding receipts (which filter and cap sources). This is the actual
// ordered retrieval result, captured before any human-readable document rendering.
export function buildRetrievalResult({ query, k, results }) {
  const retrieval = { schemaVersion: 1, kind: 'ruvnet-brain.retrieval-result', query, k,
    results: results.slice(0, k).map((row, index) => {
      const text = String(row.fullText || row.text || '');
      return { rank: index + 1, repo: row.repo, path: row.path, text, contentSha256: sha256(text) };
    }) };
  parseRetrievalResult({ structuredContent: { retrieval } }, { query, k });
  return retrieval;
}

export function parseRetrievalResult(result, { query, k }) {
  const envelope = result?.structuredContent?.retrieval;
  if (!envelope) throw new Error('UNKNOWN: incompatible MCP response lacks structured retrieval results; prose and grounding receipts cannot prove ranking');
  if (result.isError || result.disabled || result._meta?.disabled
    || envelope.schemaVersion !== 1 || envelope.kind !== 'ruvnet-brain.retrieval-result'
    || typeof query !== 'string' || !query || envelope.query !== query
    || !Number.isSafeInteger(k) || k < 1 || envelope.k !== k
    || !Array.isArray(envelope.results) || envelope.results.length > k) {
    throw new Error('structured retrieval query, depth, or result envelope mismatch');
  }
  return envelope.results.map((row, index) => {
    if (row?.rank !== index + 1 || typeof row.repo !== 'string'
      || !/^[a-z0-9][a-z0-9._-]*$/i.test(row.repo) || !safePath(row.path)
      || typeof row.text !== 'string' || !row.text || row.contentSha256 !== sha256(row.text)) {
      throw new Error('structured retrieval ordered hit or content binding mismatch');
    }
    return { ...row, repo: row.repo.toLowerCase() };
  });
}
