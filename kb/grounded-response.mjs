/**
 * Build the MCP tool-result envelope shared by every successful grounding lane.
 *
 * The first version mirrors the existing wire contract. The implementation-truth
 * regression tightens it before this helper is wired into the server.
 */
import { buildRetrievalResult } from './retrieval-result.mjs';

export function groundedToolResult({ body, grounding = null, implementation = null, extra = {}, query, k, results }) {
  const answer = String(body || '').trim();
  if (!answer) throw new Error('A grounded tool result requires an inspectable answer');
  return {
    content: [{ type: 'text', text: answer }],
    isError: false,
    structuredContent: {
      answer,
      ...(grounding ? { grounding } : {}),
      ...(implementation ? { implementation } : {}),
      ...extra,
      ...(results ? { retrieval: buildRetrievalResult({ query, k, results }) } : {}),
    },
  };
}
