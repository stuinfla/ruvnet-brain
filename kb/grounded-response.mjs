/**
 * Build the MCP tool-result envelope shared by every successful grounding lane.
 *
 * The first version mirrors the existing wire contract. The implementation-truth
 * regression tightens it before this helper is wired into the server.
 */
import { createHash } from 'node:crypto';
import { guardPassages } from './forge-guard-injection.mjs';
import { buildRetrievalResult } from './retrieval-result.mjs';

export function groundedToolResult({ body, grounding = null, implementation = null, extra = {}, query, k, results, relatedSources = [] }) {
  const primary = String(body || '').trim();
  if (!primary) throw new Error('A grounded tool result requires an inspectable answer');
  const related = prepareRelatedSources(relatedSources);
  const answer = [primary, renderRelatedSources(related)].filter(Boolean).join('\n\n');
  return {
    content: [{ type: 'text', text: answer }],
    isError: false,
    structuredContent: {
      answer,
      ...(grounding ? { grounding } : {}),
      ...(implementation ? { implementation } : {}),
      ...extra,
      ...(related.length ? { relatedSources: related } : {}),
      ...(results ? { retrieval: buildRetrievalResult({ query, k, results }) } : {}),
    },
  };
}

// Supplements never enter retrieval.results or grounding receipts, so they cannot silently
// upgrade the ranked result's grade or count as implementation evidence.
export function prepareRelatedSources(sources = []) {
  return guardPassages(sources).map((source) => {
    const text = source.fullText || source.text || '';
    return { ...source, text, contentSha256: createHash('sha256').update(text).digest('hex') };
  });
}

export function renderRelatedSources(sources = []) {
  if (!sources.length) return '';
  return 'RELATED DOCUMENTATION — separate from ranked evidence; not proof that every requirement is supported.\n'
    + sources.map((source) => `Related source: ${source.repo}/${source.path}\n`
      + `Scope: ${source.scope}\n`
      + `Source passage SHA256: ${source.passageSha256}\n`
      + `Returned excerpt SHA256: ${source.contentSha256}\n`
      + `----- related documentation -----\n${source.text}\n----- end related documentation -----`).join('\n\n');
}
