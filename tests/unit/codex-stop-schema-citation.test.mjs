// codex-cli 0.158.0's `stop.command.input` schema is the evidence cited for turn-outcome-capture.mjs's
// Codex Stop registration (Dream Cycle 2026-09-29). Dream Cycle 2026-09-30 found that citation
// hand-copied into three places the same day it was added, each naming a DIFFERENT subset of fields —
// two of them dropping `session_id` entirely, even though `captureTurnOutcome` keys a Codex turn's
// identity on `payload.session_id` FIRST, ahead of `transcript_path`
// (`sessionKey = payload.session_id || payload.transcript_path || ''`, turn-outcome-capture.mjs). A
// schema citation that omits the field the code actually depends on for identity misrepresents its own
// evidence — the same "hand-copied fixture drifts from source" class
// tests/unit/codex-claude-hook-parity.test.mjs already guards for CONTEXT_EVENTS/ALL_HOST_EVENTS.
//
// This test does not (and cannot, in this sandbox — no real codex-cli binary) verify the schema
// against a live host. It verifies the narrower, fully mechanical claim: every in-repo citation of
// this schema names the one field (`session_id`) the code reads to identify a turn, so a future
// citation cannot silently drop it without this test going red.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_STOP_SCHEMA_FIELDS } from '../../plugin/scripts/codex-hook-events.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Window of source text around each `stop.command.input` mention that a citation's field list is
// expected to live in — generous enough to span a multi-line comment, tight enough that a mention of
// `session_id` a thousand lines away in an unrelated comment cannot make this test pass by accident.
const CITATION_WINDOW = 500;

const CITATIONS = [
  'plugin/scripts/turn-outcome-capture.mjs',
  'plugin/scripts/continuity-hook-policy.mjs',
  'tests/unit/turn-outcome-capture.test.mjs',
];

describe('codex-cli 0.158.0 stop.command.input schema citations stay honest', () => {
  it('the canonical field list itself names session_id (the field the code keys identity on)', () => {
    expect(CODEX_STOP_SCHEMA_FIELDS).toContain('session_id');
  });

  for (const file of CITATIONS) {
    it(`${file}'s schema citation names session_id`, () => {
      const text = read(file);
      const at = text.indexOf('stop.command.input');
      expect(at, `expected to find a 'stop.command.input' citation in ${file}`).toBeGreaterThanOrEqual(0);
      const window = text.slice(at, at + CITATION_WINDOW);
      expect(window).toContain('session_id');
    });
  }
});
