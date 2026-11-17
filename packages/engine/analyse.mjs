// The keyword analyser, chosen by name in recipe.analyser and driven by its fields. The one function
// that cuts words: the builder indexes `analyse(text)` into the keyword stores and the keyword lane
// asks with `queryTerms(question)`, both from this file, so build and question time cannot drift.
// An analyser name this engine does not have is refused at open (and at build).
import { porterStem } from './porter.mjs';

// Identifiers written as snake_case or camelCase; each is also indexed as its separate words.
const IDENT = /\b[A-Za-z][A-Za-z0-9]*(?:(?:_[A-Za-z0-9]+)+|(?:[a-z0-9][A-Z][A-Za-z0-9]*)+)\b/g;

function splitIdentifiers(text) {
  const extra = [];
  for (const id of text.match(IDENT) || []) {
    extra.push(id.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'));
  }
  return extra.length ? `${text}\n${extra.join(' ')}` : text;
}

const ANALYSERS = {
  // The measured keyword analyser: ASCII letters and digits, stop words and short numbers dropped,
  // Porter stems, identifiers also split into their words. The index stores the analysed tokens.
  'lucene-porter-ident': {
    words(text, a) {
      const stop = stopSet(a);
      const minNum = a.minNumberLength ?? 0;
      const out = [];
      const src = a.splitIdentifiers === false ? String(text) : splitIdentifiers(String(text));
      for (const raw of src.toLowerCase().split(/[^a-z0-9]+/g)) {
        if (raw.length < a.minTokenLength || stop.has(raw)) continue;
        if (/^\d+$/.test(raw) && raw.length < minNum) continue;
        out.push(a.stemmer === 'none' ? raw : porterStem(raw));
      }
      return out;
    },
  },
};

const stopCache = new WeakMap();
function stopSet(a) {
  if (!stopCache.has(a)) stopCache.set(a, new Set(a.stopwords));
  return stopCache.get(a);
}

function impl(analyser) {
  const a = ANALYSERS[analyser?.name];
  if (!a) throw new Error(`This pack's recipe names keyword analyser ${analyser?.name}, which this engine does not have.`);
  return a;
}

/** Throws one plain sentence when the recipe's analyser is not one this engine has. */
export function checkAnalyser(analyser) {
  impl(analyser);
}

/** The analysed tokens of `text` (stop words already dropped). */
export function words(text, analyser) {
  return impl(analyser).words(text, analyser);
}

/** The text to store in an index field: the analysed tokens, space-separated. */
export function analyse(text, analyser) {
  return words(text, analyser).join(' ');
}

/** Query terms: the analysed tokens of the question, first occurrence order, capped. */
export function queryTerms(text, analyser) {
  const out = [];
  const seen = new Set();
  for (const w of words(text, analyser)) {
    if (!seen.has(w)) (seen.add(w), out.push(w));
    if (out.length >= analyser.maxQueryTerms) break;
  }
  return out;
}
