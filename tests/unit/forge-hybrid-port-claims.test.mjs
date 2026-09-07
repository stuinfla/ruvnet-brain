// forge-hybrid-port-claims.test.mjs — kb/forge-hybrid.mjs's own header comment names, in a
// comma-separated manifest, which functions "the port" from ruflo's hybrid-retrieval.ts covers. That
// manifest is a code-existence citation — the same class of claim adr-citation-integrity.test.mjs
// binds for numeric figures cited to an ADR, applied here to a file's self-description of its own
// exports. Until 2026-08-23 the manifest named `mmrRerank` even though no such function was ever
// defined in this file (it appeared only in that same comment); docs/adr/0025's Open Items repeated
// the identical false claim ("ported function... not yet called"). This gate makes that class
// un-shippable going forward, the same way adr-citation-integrity.test.mjs did for figures.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const HYBRID_PATH = path.join(ROOT, 'kb/forge-hybrid.mjs');

// Split on commas OUTSIDE parens — "bm25Score (Okapi k1=1.5,b=0.75)" is one manifest item, not two.
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth <= 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Extracts the bare function identifier each manifest item names — only the item's LEADING
 * identifier, so any trailing prose in the final item (e.g. an explanatory sentence appended after
 * the real list) is never mistaken for a claimed function name.
 */
export function claimedPortFunctions(manifestText) {
  return splitTopLevel(manifestText)
    .map((seg) => seg.trim().match(/^\W*([a-zA-Z][a-zA-Z0-9]*)/))
    .filter(Boolean)
    .map((m) => m[1]);
}

function realExports(src) {
  return new Set([...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]));
}

function portManifest(headerSrc) {
  const m = headerSrc.match(/hybrid-retrieval\.ts\s*[—-]+\s*([\s\S]*?)\n\s*\/\/\s*ruflo ADR-082/);
  if (!m) {
    throw new Error(
      'forge-hybrid.mjs header no longer names the ruflo hybrid-retrieval.ts source in the expected '
      + 'shape — update this test alongside the comment.'
    );
  }
  return m[1].replace(/\/\//g, ' ');
}

describe("kb/forge-hybrid.mjs's header comment names only functions it actually exports", () => {
  const src = fs.readFileSync(HYBRID_PATH, 'utf8');
  const exported = realExports(src);

  it('detector: catches the pre-fix header, which claimed `mmrRerank` as part of the port', () => {
    const knownBadManifest = 'bm25Score (Okapi k1=1.5,b=0.75),\n'
      + '    normalise (min-max), hybridScores (α·cosineNorm + (1-α)·bm25Norm), multiFieldBM25, mmrRerank.';
    const claimed = claimedPortFunctions(knownBadManifest);
    expect(claimed).toContain('mmrRerank');
    const unbacked = claimed.filter((name) => !exported.has(name));
    expect(unbacked).toEqual(['mmrRerank']);
  });

  it('detector: the post-fix wording (mmrRerank moved out of the manifest, into its own "NEVER ported" sentence) passes', () => {
    const knownGoodManifest = 'bm25Score (Okapi k1=1.5,b=0.75),\n'
      + '    normalise (min-max), hybridScores (α·cosineNorm + (1-α)·bm25Norm), multiFieldBM25. `mmrRerank`\n'
      + '    (diversity re-ranking, mmrLambda=0.7) was NEVER ported — no such function is defined below;\n'
      + '    it remains future work (docs/adr/0025-hybrid-retrieval-and-self-retrieval-gate.md, Open Items).';
    const claimed = claimedPortFunctions(knownGoodManifest);
    expect(claimed).not.toContain('mmrRerank');
    expect(claimed.filter((name) => !exported.has(name))).toEqual([]);
  });

  it('the live header comment claims only functions kb/forge-hybrid.mjs actually exports', () => {
    const manifest = portManifest(src);
    const claimed = claimedPortFunctions(manifest);
    expect(claimed.length).toBeGreaterThan(0); // sanity: the manifest still names something real
    const unbacked = claimed.filter((name) => !exported.has(name));
    expect(unbacked, `header claims these as ported but they are not exported: ${unbacked.join(', ')}`).toEqual([]);
  });

  it('ground truth this gate trusts: mmrRerank is not exported by kb/forge-hybrid.mjs', () => {
    expect(exported.has('mmrRerank')).toBe(false);
  });
});
