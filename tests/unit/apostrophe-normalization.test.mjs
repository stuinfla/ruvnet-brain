// tests/unit/apostrophe-normalization.test.mjs — the router reads possessives ("rUv's", "agent's
// scaffolding", "each other's context", "what's uncovered") with a straight apostrophe, but phones
// and word processors type U+2019 (also U+2018, U+02BC). Pinned: every form routes like the straight one.
import { describe, expect, it } from 'vitest';
import { contentTokens, normalizeApostrophes } from '../../kb/card-lane.mjs';
import { ruvAuthorshipIntent, sourceCardHasUnsafePolarity } from '../../kb/forge-ask-all.mjs';
import { versionIntent } from '../../kb/corpus-freshness.mjs';

const FORMS = ['’', '‘', 'ʼ'];
const variants = (q) => FORMS.map((c) => q.replaceAll("'", c));

describe('apostrophe normalization', () => {
  it('maps the curly and modifier apostrophes to a straight one and nothing else', () => {
    expect(normalizeApostrophes('rUv’s ‘x’ agentʼs')).toBe("rUv's 'x' agent's");
    expect(normalizeApostrophes('plain "quotes" stay')).toBe('plain "quotes" stay');
  });

  it.each([
    "I want to improve my agent's scaffolding without swapping out the model itself",
    "my agents work in the same repo and clobber each other's context",
    "what's uncovered by my tests?",
  ])('card-lane phrase normalization reads every apostrophe form alike: %s', (q) => {
    for (const v of variants(q)) expect(contentTokens(v)).toEqual(contentTokens(q));
  });

  it.each([
    "per rUv's tutorial on free training",
    "What is rUv's TikTok-like recommender algorithm specification?",
    "Where are rUv's posts about the self-learning flywheel?",
  ])('ruvAuthorshipIntent recognises a curly possessive: %s', (q) => {
    expect(ruvAuthorshipIntent(q)).toBe(true);
    for (const v of variants(q)) expect(ruvAuthorshipIntent(v)).toBe(true);
  });

  it.each([
    "Can't AgentDB keep memory across restarts?",
    "Why doesn't ruflo spawn agents offline?",
  ])('a curly-apostrophe negation still marks a source-card question unsafe: %s', (q) => {
    expect(sourceCardHasUnsafePolarity(q)).toBe(true);
    for (const v of variants(q)) expect(sourceCardHasUnsafePolarity(v)).toBe(true);
  });

  it("a curly-apostrophe \"what's new\" is still a version question", () => {
    expect(versionIntent("what's new in ruflo").intent).toBe(true);
    for (const v of variants("what's new in ruflo")) expect(versionIntent(v).intent).toBe(true);
  });

  it.each([
    "How many threads does rUv's HNSW index use?",
    "What are the hardware specs for rUv's Cognitum seed?",
    "How do I post a task to rUv's agent queue?",
  ])('ruvAuthorshipIntent still rejects a product question in every form: %s', (q) => {
    expect(ruvAuthorshipIntent(q)).toBe(false);
    for (const v of variants(q)) expect(ruvAuthorshipIntent(v)).toBe(false);
  });
});
