// The last step of every tool result (wave 3): the delivery guard counts EVERYTHING the server puts on
// the wire for one result that a host may count against its limit: the text of every content block
// (any other block serialized) plus the structured content, serialized. It is not known which part a
// host counts, so the sum is held to the ceiling (contract/delivery.mjs: 44,000 characters and 20,000
// estimated tokens, or a recipe's lower numbers). No text may reach the host twice: a structured copy
// that repeats a text block is dropped. If the result is still over, any structured content is dropped,
// then the text is cut at a line end and says so on its last line.
import { ceilingOf, estimateTokens } from '../contract/delivery.mjs';

const textOf = (block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify(block));

/** Every part of one tool result a host may count, in order. */
export function wireParts(result) {
  const parts = (result?.content ?? []).map(textOf);
  if (result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts;
}

/** { chars, tokens } of everything one tool result puts on the wire. */
export function wireSize(result) {
  const parts = wireParts(result);
  return { chars: parts.reduce((n, p) => n + p.length, 0), tokens: parts.reduce((n, p) => n + estimateTokens(p), 0) };
}

const fits = (result, ceil) => {
  const s = wireSize(result);
  return s.chars <= ceil.maxChars && s.tokens <= ceil.maxTokens;
};

/** True when the structured content carries the text of a text block again. */
function duplicates(result) {
  if (result.structuredContent === undefined) return false;
  const s = JSON.stringify(result.structuredContent);
  return (result.content ?? []).some((b) => b?.type === 'text' && b.text && (s.includes(JSON.stringify(b.text).slice(1, -1)) || b.text.includes(s)));
}

/** Holds one tool result to the ceiling of `recipe` (null: the host's numbers). Returns the result to send. */
export function deliver(result, recipe = null) {
  const ceil = ceilingOf(recipe);
  let out = { ...result };
  if (duplicates(out) || (out.structuredContent !== undefined && !fits(out, ceil))) delete out.structuredContent;
  if (fits(out, ceil)) return out;
  const blocks = (out.content ?? []).filter((b) => b?.type === 'text');
  const text = blocks.map((b) => b.text).join('\n');
  let keep = Math.min(text.length, ceil.maxChars);
  for (;;) {
    const cutAt = text.lastIndexOf('\n', Math.max(0, keep - 1));
    keep = cutAt > 0 ? cutAt : Math.max(0, keep - 1000);
    const note = `\nCUT · this result was cut to stay within what the host delivers (${ceil.maxChars} characters, ${ceil.maxTokens} estimated tokens)`;
    out = { ...out, content: [{ type: 'text', text: text.slice(0, keep) + note }] };
    if (fits(out, ceil) || keep === 0) return out;
  }
}

/** The one way the server builds a tool result: text (and the error flag), held to the ceiling. */
export const toolResult = (text, isError, recipe) => deliver({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }, recipe);
