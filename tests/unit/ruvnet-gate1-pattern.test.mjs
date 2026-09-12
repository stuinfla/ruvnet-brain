import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUVNET_GATE1_PATTERN, ruvnetGate1Matches } from '../../plugin/scripts/ruvnet-gate1-pattern.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GROUND_RUVNET = path.join(ROOT, 'plugin', 'scripts', 'ground-ruvnet.sh');

/**
 * PROVES BYTE-IDENTITY, not "close enough". ruvnet-gate1-pattern.mjs's whole reason to exist is
 * that ground-ruvnet.sh's Gate 1 regex cannot be imported by a Node script, so it is copied — and a
 * copy that can silently drift from its source is worse than no copy at all (the Stop-time gate
 * would then judge "did this prompt need grounding" against a DIFFERENT rule than the one that
 * actually told the model to ground it). This test parses ground-ruvnet.sh's real Gate 1 line and
 * fails if the two are not the exact same string.
 */
function extractGate1PatternFromShellScript() {
  const src = fs.readFileSync(GROUND_RUVNET, 'utf8');
  // The exact shape: `if printf '%s' "$TEXT" | grep -qiE '<pattern>'; then` right after the
  // "Gate 1: does the task touch the rUv ecosystem?" header comment.
  const m = /Gate 1: does the task touch the rUv ecosystem[\s\S]*?grep -qiE '([^']+)'/.exec(src);
  if (!m) throw new Error('could not locate Gate 1\'s grep -qiE pattern in ground-ruvnet.sh — did it move or get rewritten?');
  return m[1];
}

describe('the Stop-time gate\'s copy of Gate 1 never drifts from ground-ruvnet.sh', () => {
  it('extracts a real, non-trivial pattern from ground-ruvnet.sh (or this test is checking nothing)', () => {
    const shellPattern = extractGate1PatternFromShellScript();
    expect(shellPattern.length).toBeGreaterThan(50);
    expect(shellPattern).toContain('\\bruvnet\\b');
  });

  it('is byte-identical to ground-ruvnet.sh\'s Gate 1 ERE (grep -qiE), once the shell-quoting is undone', () => {
    const shellPattern = extractGate1PatternFromShellScript();
    // The shell literal is single-quoted, so `\b` inside it is two real characters (backslash, b) —
    // exactly what the JS string with `\\b` also decodes to. No further unescaping is needed for an
    // ERE with no embedded single quotes (ground-ruvnet.sh's Gate 1 pattern has none).
    expect(RUVNET_GATE1_PATTERN).toBe(shellPattern);
  });

  it('agrees with the real shell behavior (grep -qiE) on representative inputs, both languages, same verdict', () => {
    const cases = [
      ['build a ruflo agent', true],
      ['use RVF for the vector store', true],
      ['what is SPARC methodology', true],
      ['integrate claude-flow into the pipeline', true],
      ['a completely unrelated cooking recipe', false],
      ['swap in pgvector for our search', false], // Gate 1 does not fire on classical defaults (that's Gate 2/DRIFT)
      ['SWARMS of bees', true], // case-insensitive, and \bswarms?\b matches plural
    ];
    for (const [text, expected] of cases) {
      const shellResult = shellGrepMatches(text);
      expect(shellResult, `shell grep -qiE disagrees with the test's own expectation for ${JSON.stringify(text)}`).toBe(expected);
      expect(ruvnetGate1Matches(text), `JS pattern disagrees with shell grep -qiE for ${JSON.stringify(text)}`).toBe(shellResult);
    }
  });
});

function shellGrepMatches(text) {
  const pattern = extractGate1PatternFromShellScript();
  const r = spawnSync('grep', ['-qiE', pattern], { input: text, encoding: 'utf8' });
  return r.status === 0;
}
