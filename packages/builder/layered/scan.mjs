// Builder-side helpers of the layered store: line indexing and balanced-bracket scanning. Ported from
// the L+ prototype (layered/lib/scan.mjs); the line and identifier helpers live in the engine
// (engine/layered/text.mjs) so the reader cuts lines exactly as the builder did.
// Everything here is deterministic; nothing generates text.
export { sha256, toLines, span, identSplit } from '../../engine/layered/text.mjs';

// Offsets of each line start in the joined (\n) text built from `lines`.
export function lineStarts(lines) {
  const starts = new Array(lines.length);
  let o = 0;
  for (let i = 0; i < lines.length; i++) { starts[i] = o; o += lines[i].length + 1; }
  return starts;
}
export function offsetToLine(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

const PAIRS = { '{': '}', '[': ']', '(': ')' };

// Find the index of the bracket closing the one at `open`. Skips strings and comments.
// lang: 'js' | 'rs' | 'py'. Returns -1 if unbalanced or over `limit` chars.
export function matchBalanced(src, open, lang = 'js', limit = 200000) {
  const stack = [PAIRS[src[open]]];
  if (!stack[0]) return -1;
  const end = Math.min(src.length, open + limit);
  let i = open + 1;
  while (i < end) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? end : e + 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? end : e + 2; continue; }
    if (lang === 'py' && c === '#') { const e = src.indexOf('\n', i); i = e < 0 ? end : e + 1; continue; }
    if (c === '"' || (c === "'" && lang !== 'rs') || (c === '`' && lang === 'js')) {
      i = skipString(src, i, c, lang, end); continue;
    }
    if (lang === 'rs' && c === 'r' && (n === '#' || n === '"') && !/\w/.test(src[i - 1] || '')) {
      const m = /^r(#*)"/.exec(src.slice(i, i + 20));
      if (m) { const close = '"' + m[1]; const e = src.indexOf(close, i + m[0].length); i = e < 0 ? end : e + close.length; continue; }
    }
    if (lang === 'rs' && c === "'") { // char literal vs lifetime
      const m = /^'(\\.[^']*|[^'\\])'/.exec(src.slice(i, i + 12));
      i += m ? m[0].length : 1; continue;
    }
    if (PAIRS[c]) { stack.push(PAIRS[c]); i++; continue; }
    if (c === '}' || c === ']' || c === ')') {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      if (!stack.length) return i;
    }
    i++;
  }
  return -1;
}

function skipString(src, i, q, lang, end) {
  let j = i + 1;
  while (j < end) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      const e = matchBalanced(src, j + 1, lang); if (e < 0) return end; j = e + 1; continue;
    }
    if (c === q) return j + 1;
    if (c === '\n' && q !== '`' && lang !== 'rs' && lang !== 'py') return j + 1; // unterminated JS string
    j++;
  }
  return end;
}


export const LIT = String.raw`(?:-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?(?:\s*\*\s*\d[\d_]*)*|'[^'\n]*'|"[^"\n]*"|true|false|null|None)`;

export function langOf(path) {
  if (/\.(ts|tsx|js|mjs|cjs|jsx|svelte|vue)$/.test(path)) return 'js';
  if (/\.rs$/.test(path)) return 'rs';
  if (/\.py$/.test(path)) return 'py';
  if (/\.(md|mdx|markdown|rst|txt)$/i.test(path)) return 'doc';
  if (/\.(sh|bash|zsh)$/.test(path)) return 'sh';
  if (/\.(toml|json|ya?ml)$/.test(path)) return 'cfg';
  return 'other';
}

export const indentOf = (l) => /^\s*/.exec(l)[0].length;
