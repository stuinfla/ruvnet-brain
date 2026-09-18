import crypto from 'node:crypto';
import path from 'node:path';
import { classifyResultEvidence } from './implementation-evidence.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const safePath = (value) => typeof value === 'string' && value.length > 0
  && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
  && !/^[a-z]:/i.test(value)
  && !value.split(/[\\/]/).includes('..');

// Input is already ranked. Keep the best representative and disclose the other
// paths; identical text from another repository or evidence class stays separate.
export function collapseIdenticalResults(ranked) {
  const groups = new Map();
  const alternatives = new Map();
  const result = [];
  for (const original of ranked) {
    const row = { ...original };
    const text = row.fullText || row.text || '';
    // A shared excerpt is not proof of equivalent passages outside that window.
    if (!text || !safePath(row.path) || row.truncated || row.omittedAlternativePaths
      || /\[\.\.\..*(?:omitted|window|truncat)/i.test(text)) {
      result.push(row); continue;
    }
    const classification = classifyResultEvidence(row);
    const owner = row.repo === 'concepts' ? row.path.split('/')[0] : null;
    const key = JSON.stringify([row.repo, owner, classification.evidenceClass, classification.lifecycleStatus, sha256(text)]);
    const prior = groups.get(key);
    if (!prior) {
      groups.set(key, row); alternatives.set(row, new Set(row.alternativePaths || []));
      result.push(row); continue;
    }
    const paths = alternatives.get(prior);
    paths.add(row.path);
    for (const value of row.alternativePaths || []) paths.add(value);
  }
  for (const [row, paths] of alternatives) {
    paths.delete(row.path);
    if (paths.size) {
      row.alternativePaths = [...paths].sort().slice(0, 32);
      if (paths.size > 32) row.omittedAlternativePaths = paths.size - 32;
    }
  }
  return result;
}

// Independent of grounding receipts (which filter and cap sources). This is the actual
// ordered retrieval result, captured before any human-readable document rendering.
export function buildRetrievalResult({ query, k, results }) {
  const retrieval = { schemaVersion: 1, kind: 'ruvnet-brain.retrieval-result', query, k,
    results: results.slice(0, k).map((row, index) => {
      const text = String(row.fullText || row.text || '');
      return { rank: index + 1, repo: row.repo, path: row.path, text, contentSha256: sha256(text),
        ...(row.alternativePaths?.length ? { alternativePaths: [...row.alternativePaths] } : {}),
        ...(row.omittedAlternativePaths ? { omittedAlternativePaths: row.omittedAlternativePaths } : {}) };
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
    if (row.alternativePaths !== undefined && (!Array.isArray(row.alternativePaths)
      || row.alternativePaths.length > 32
      || row.alternativePaths.some(value => !safePath(value) || value === row.path)
      || new Set(row.alternativePaths).size !== row.alternativePaths.length)) {
      throw new Error('structured retrieval alternative source paths are invalid');
    }
    if (row.omittedAlternativePaths !== undefined && (!Number.isSafeInteger(row.omittedAlternativePaths)
      || row.omittedAlternativePaths < 1 || row.alternativePaths?.length !== 32)) {
      throw new Error('structured retrieval omitted source count is invalid');
    }
    return { ...row, repo: row.repo.toLowerCase() };
  });
}
