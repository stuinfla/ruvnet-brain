// What a host delivers of one tool result (contract 1.1). Measured 2026-11-17 on the host real users
// run: tool results of 51,000 to 60,000 characters were rejected 95-97% of the time ("exceeds maximum
// allowed tokens"); up to 47,000 were delivered 463 of 463. So the whole text of one result stays within
// 44,000 characters and 20,000 estimated tokens, whatever a recipe's budgets say. A recipe may name lower
// numbers in result.delivery; the engine trims to the recipe's numbers when it names them, and the server
// holds every result to the lower of the two as its last step (a contract-v1 recipe names none).
export const DELIVERY = { maxChars: 44_000, maxTokens: 20_000 };

/** The ceiling for a recipe: the lower of the host's numbers and the recipe's own. */
export const ceilingOf = (recipe) => ({
  maxChars: Math.min(DELIVERY.maxChars, recipe?.result?.delivery?.maxChars ?? Infinity),
  maxTokens: Math.min(DELIVERY.maxTokens, recipe?.result?.delivery?.maxTokens ?? Infinity),
});

/** A conservative token estimate: the larger of characters / 3 and the count of word and
 *  punctuation pieces (dense code tokenises far worse than prose). */
export function estimateTokens(text) {
  let pieces = 0;
  for (const _ of text.matchAll(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g)) pieces++;
  return Math.max(Math.ceil(text.length / 3), pieces);
}
