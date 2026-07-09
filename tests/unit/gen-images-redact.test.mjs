// tests/unit/gen-images-redact.test.mjs — scripts/gen-images.mjs's redact() (line 12) is the ONLY
// piece of real logic in an otherwise one-off OpenAI-calling asset-generation script (per the
// 2026-07-08 pass-6 audit, which triaged this file as "one-off tooling, only real logic is key
// redaction" but did not write a skeleton for it). It is untested despite being the one thing standing
// between a failed image-gen call and a leaked OPENAI_API_KEY in console output / captured CI logs.
//
// WHY THIS MATTERS: `redact` (line 12) is called on every caught error message before it reaches
// console.log/console.error (lines 41, 43) specifically "to never let a key reach logs" (the file's
// own comment). There is also a second, un-exported piece of key-handling logic worth locking down:
// the KEY extraction itself (line 10) — `RAWKEY.match(/sk-[A-Za-z0-9_\-]+/) || ['']` picks the FIRST
// valid sk-... token out of a raw env value, explicitly to tolerate duplicate lines / trailing
// whitespace in a hand-edited .env file. Neither regex has ever been run against an adversarial input
// (a key-shaped string embedded mid-sentence, multiple keys in one message, no key at all).
//
// PREREQUISITE (why this is a skeleton): gen-images.mjs is an unguarded top-level script — line 11
// calls `process.exit(2)` directly if no OPENAI_API_KEY is found (which WILL fire in any test process
// that imports this module without the env var set, silently killing the test runner, not just this
// file's tests), and the top-level for-loop (line 36) makes real fetch() calls to api.openai.com and
// writes PNGs to disk unconditionally on import. Same additive fix as this suite's other asset/tooling
// gaps:
//
//   export const redact = (s) => String(s).replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-***');
//   export const extractKey = (raw) => (String(raw).match(/sk-[A-Za-z0-9_\-]+/) || [''])[0];
//   if (import.meta.url === `file://${process.argv[1]}`) { /* existing lines 9-47 unchanged, using
//     const KEY = extractKey(RAWKEY); if (!KEY) { ...; process.exit(2); } */ }
//
// Flag to Stuart before applying (standing rule for every export-ask in this suite).
import { describe, it, expect } from 'vitest';

describe.todo('redact(s) — key scrubbing before it ever reaches a log line (requires export, see file header)', () => {
  it.todo('replaces a full sk-... token embedded inside an arbitrary error message with "sk-***"');
  it.todo('replaces MULTIPLE distinct sk-... tokens in the same string (global flag), not just the first');
  it.todo('leaves a string with no key-shaped substring completely unchanged');
  it.todo('does NOT redact the bare literal "sk-" with nothing following it — the [A-Za-z0-9_-]+ requires at least one trailing char, so a message that happens to end mid-token is not falsely flagged as a full key');
  it.todo('coerces a non-string input via String(s) without throwing, e.g. an Error object or a number, before applying the regex');
  it.todo('handles a key containing underscores and hyphens (the character class explicitly includes both) without truncating the redaction early');
});

describe.todo('extractKey(raw) — first-valid-token extraction from a raw .env value (requires export, see file header)', () => {
  it.todo('returns the sk-... token when the raw value is exactly one clean key with no surrounding whitespace');
  it.todo('returns only the FIRST token when the raw value contains two sk-... tokens (e.g. a duplicated .env line concatenated by a prior read) — documents that a stale second key is silently ignored rather than flagged');
  it.todo('trims a key surrounded by trailing whitespace/newline without including the whitespace in the returned token');
  it.todo('returns an empty string, not null/undefined/throw, when the raw value contains no sk-... shaped token at all — the caller\'s `if (!KEY)` check depends on this being falsy-but-safe-to-use in a template string');
});
