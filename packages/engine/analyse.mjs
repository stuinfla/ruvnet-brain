// The keyword analyser, driven entirely by recipe.analyser. Used at question time by the lexical
// lane and at build time to pick probe terms, so both sides cut words the same way.
export function words(text, analyser) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= analyser.minTokenLength);
}

/** Query terms: words minus stop words, first occurrence order, capped. */
export function queryTerms(text, analyser) {
  const stop = new Set(analyser.stopwords);
  const out = [];
  for (const w of words(text, analyser)) {
    if (!stop.has(w) && !out.includes(w)) out.push(w);
    if (out.length >= analyser.maxQueryTerms) break;
  }
  return out;
}
