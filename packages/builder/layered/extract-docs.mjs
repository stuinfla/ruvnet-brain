// L2 extractors of the layered store that run on any text (ported from the L+ prototype,
// layered/lib/extract-docs.mjs): honesty markers, ADR / section status, doc lines with numbers.

// Ordered: the first matching term names the row; all matched terms are recorded.
export const MARKER_TERMS = [
  ['todo!', /\btodo!\s*\(/],
  ['unimplemented!', /\bunimplemented!\s*\(/],
  ['not implemented', /\bnot\s+(?:yet\s+)?implemented\b/i],
  ['NOT TESTED', /\bnot\s+tested\b/i],
  ['Not measured', /\bnot\s+measured\b/i],
  ['not wired', /\bnot\s+(?:yet\s+)?wired\b/i],
  ['TODO', /\bTODO\b/],
  ['FIXME', /\bFIXME\b/],
  ['XXX', /\bXXX\b/],
  ['HACK', /\bHACK\b/],
  ['stub', /\bstub(?:s|bed)?\b/i],
  ['placeholder-attr', /\bplaceholder\s*=\s*["'{]|\bplaceholder:\s*['"`]/i],
  ['placeholder', /\bplaceholder/i],
  ['experimental', /\bexperimental\b/i],
  ['deferred', /\bdeferred\b/i],
];

export function extractMarkers(lines) {
  const rows = [];
  lines.forEach((l, i) => {
    const hit = MARKER_TERMS.filter(([, re]) => re.test(l)).map(([t]) => t);
    if (!hit.length) return;
    if (hit[0] === 'placeholder-attr') hit.splice(hit.indexOf('placeholder'), hit.includes('placeholder') ? 1 : 0);
    const a = Math.max(1, i + 1 - 3), b = Math.min(lines.length, i + 1 + 3);
    rows.push({ kind: 'marker', symbol: hit[0], line_start: a, line_end: b, anchor: i + 1, term: hit.join('|') });
  });
  return rows;
}

const RE_STATUS_KV = /^\s*(?:[-*>|]\s*)*(?:\*\*|__)?(Status|Date|Decided|Accepted|Supersedes|Superseded[ -]by|Deciders|Implemented|Last[ -]updated)(?:\*\*|__)?\s*(?:\*\*|__)?\s*[:|]/i;
const RE_STATUS_HEAD = /^#{1,6}\s+.*\b(Status|Known boundaries|Known issues|Known limitations|Limitations|Current state|Maturity|What is not (?:done|implemented)|Not yet implemented)\b/i;

export function isAdrPath(p) { return /(^|\/)(adrs?|ADRs?|decisions)\//.test(p) || /ADR[-_]?\d+/i.test(p.split('/').pop()); }

export function extractStatus(lines, path) {
  const rows = [];
  const adr = isAdrPath(path);
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    if (adr && i < 60) { const m = RE_STATUS_KV.exec(l); if (m) rows.push({ kind: 'status', symbol: m[1], line_start: i + 1, line_end: i + 1, term: 'adr-field' }); }
    const h = RE_STATUS_HEAD.exec(l);
    if (h) {
      const lvl = /^#+/.exec(l)[0].length;
      let b = i + 1;
      while (b < lines.length && b - i < 15) { const hm = /^(#+)\s/.exec(lines[b]); if (hm && hm[1].length <= lvl) break; b++; }
      rows.push({ kind: 'status', symbol: h[1], line_start: i + 1, line_end: b, term: 'section' });
    }
  });
  return rows;
}

// A doc line that states a number next to a named setting: digit + (inline code | --flag | identifier with _ or camelCase | setting word).
const RE_NAMED = /`[^`]+`|--[a-z][\w-]+|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z]\w*\b|\b(?:default|defaults|max|min|limit|threshold|timeout|ttl|size|dimensions?|ef|m|k|top-?k|port|batch|interval|budget|cap|window|rate)\b/;
export function extractDocNumbers(lines) {
  const rows = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (!/\d/.test(l) || /^\s*\|?[\s:|-]+\|?\s*$/.test(l)) return;
    if (l.length > 1500) return;
    const named = RE_NAMED.exec(l); if (!named) return;
    if (!/(?:^|[^\w.#/-])\d/.test(l.replace(/https?:\/\/\S+/g, ''))) return; // a standalone number, not inside a URL/hash
    rows.push({ kind: 'doc-number-line', symbol: named[0].replace(/`/g, '').slice(0, 120), line_start: i + 1, line_end: i + 1, term: inFence ? 'fenced' : 'prose' });
  });
  return rows;
}
