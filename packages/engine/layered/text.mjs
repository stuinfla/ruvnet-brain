// Text helpers shared by the layered store's builder (packages/builder/layered) and its reader
// (packages/engine/layered/query.mjs), so a line range means the same lines on both sides.
// Ported from the L+ prototype (RVF-KnowledgeBases/ruvnet-brain-v5-mini-20261117/layered/lib/scan.mjs).
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** File text as numbered lines, exactly as `sed -n 'a,bp'` prints them, minus a trailing \r. */
export function toLines(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The verbatim text of the 1-based inclusive line range a..b. */
export const span = (lines, a, b) => lines.slice(a - 1, b).join('\n');

/** An identifier-split copy for the full-text index: efSearch -> ef Search, HNSWConfig -> HNSW Config. */
export function identSplit(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.:/]+/g, ' ');
}
