// Token estimators, named and versioned in the recipe (units.passage.symbolChunker.tokenEstimator).
// The measured chunker counted with the real bge-base WordPiece tokenizer; the builder ships no model,
// so it estimates the way that tokenizer splits: whitespace and every punctuation mark separate
// pieces, a run of letters costs one token per `lettersPerToken` letters (rounded up), a run of digits
// one per `digitsPerToken`, any other character one. The estimate is additive over whitespace, so the
// count of lines joined by "\n" is the sum of the per-line counts (the prefix-sum model relies on it).
const PIECE = /[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/gu;

function approxWordpiece({ lettersPerToken, digitsPerToken }) {
  if (!Number.isInteger(lettersPerToken) || lettersPerToken < 1 || !Number.isInteger(digitsPerToken) || digitsPerToken < 1) {
    throw new Error('the approx-wordpiece estimator needs whole-number lettersPerToken and digitsPerToken in the recipe');
  }
  const count = (text) => {
    let n = 0;
    for (const m of String(text).matchAll(PIECE)) {
      const p = m[0];
      if (/^[A-Za-z]/.test(p)) n += Math.ceil(p.length / lettersPerToken);
      else if (/^[0-9]/.test(p)) n += Math.ceil(p.length / digitsPerToken);
      else n += 1;
    }
    return n;
  };
  return { count };
}

export const ESTIMATORS = { 'approx-wordpiece': { 1: approxWordpiece } };
