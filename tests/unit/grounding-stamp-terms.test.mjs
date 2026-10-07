// tests/unit/grounding-stamp-terms.test.mjs — H1 / GitHub #316: "no successful search_ruvnet this
// turn" fired even after a real, successful search_ruvnet call.
//
// ROOT CAUSE (two independent gaps, both fixed here):
//   1. grounding-turn-mark.mjs arms the Stop-time turn gate off the FULL Gate-1 vocabulary in
//      ruvnet-gate1-pattern.mjs (ruvnet, ruflo, ruvector, rvf, agentdb, agenticow, rulake, ruview,
//      rupixel, ruv-fann, agentic-flow, synthlang, dspy, qudag, safla, metaharness, cve-bench,
//      sparc, swarm(s), claude-flow, rUv) — but grounding-stamp.sh only recognised a DIFFERENT,
//      narrower 9-term list (the one it shares with ground-before-write.sh's write gate) that
//      omitted `ruvnet` itself and eleven other Gate-1 terms. A search literally about "ruvnet"
//      minted no per-term stamp at all.
//   2. Even with the vocabulary fixed, a query that grounds a real answer without literally naming
//      any recognised product term (e.g. "how should agent handoffs stay consistent") would still
//      mint nothing under a term-matching-only design — the Stop gate must treat ANY successful
//      search_ruvnet as satisfying "a search happened this turn", not only a term-matching one.
//
// Both regression tests below are run against the pre-fix tree first (see the recorded RED output
// in each `it` block's comment) and pass only on the fixed tree.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUVNET_GATE1_TERMS } from '../../plugin/scripts/ruvnet-gate1-pattern.mjs';
import { markerPathFor } from '../../plugin/scripts/grounding-turn-mark.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = path.join(ROOT, 'plugin', 'scripts', 'grounding-stamp.sh');
const MARK = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-mark.mjs');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-gate.mjs');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/** Parses `NAME="space separated terms"` out of grounding-stamp.sh's source (bash has no export
 *  grounding-stamp.sh could hand a JS test, so this mirrors ruvnet-gate1-pattern.test.mjs's own
 *  "parse the real shell source" idiom rather than re-typing the list a third time). */
function extractBashTermList(varName) {
  const src = fs.readFileSync(STAMP, 'utf8');
  const re = new RegExp(`${varName}="([^"]*)"`);
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${varName}="..." in grounding-stamp.sh — did it move or get rewritten?`);
  return m[1].split(/\s+/).filter(Boolean);
}

describe('grounding-stamp.sh mints stamps for the FULL Gate-1 vocabulary, not a drifted subset', () => {
  it('WRITE_GATE_TERMS + GATE1_ONLY_TERMS together cover every RUVNET_GATE1_TERMS entry (H1 sync contract)', () => {
    const writeGateTerms = extractBashTermList('WRITE_GATE_TERMS');
    const gate1OnlyTerms = extractBashTermList('GATE1_ONLY_TERMS');
    const combined = new Set([...writeGateTerms, ...gate1OnlyTerms]);

    // Sanity: RUVNET_GATE1_TERMS itself must be non-trivial, or this test checks nothing.
    expect(RUVNET_GATE1_TERMS.length).toBeGreaterThan(15);
    expect(RUVNET_GATE1_TERMS).toContain('ruvnet');

    const missing = RUVNET_GATE1_TERMS.filter((t) => !combined.has(t));
    expect(missing, `grounding-stamp.sh's term lists are missing Gate-1 terms: ${missing.join(', ')}`).toEqual([]);
  });

  it('specifically covers "ruvnet" — the exact GitHub #316 omission', () => {
    const writeGateTerms = extractBashTermList('WRITE_GATE_TERMS');
    const gate1OnlyTerms = extractBashTermList('GATE1_ONLY_TERMS');
    expect([...writeGateTerms, ...gate1OnlyTerms]).toContain('ruvnet');
  });
});

/** Fires grounding-stamp.sh exactly as Claude Code's PostToolUse hook would. */
function fireStamp(home, { query, toolResponse }) {
  return spawnSync('bash', [STAMP], {
    input: JSON.stringify({
      tool_name: 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet',
      tool_input: { query },
      tool_response: toolResponse,
    }),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

describe.skipIf(!hasBash || process.platform === 'win32')('grounding-stamp.sh — behavioral proof (real subprocess)', () => {
  it('a query literally about "ruvnet" mints a "ruvnet" stamp (RED on pre-fix 9-term list)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-ruvnet-'));
    const r = fireStamp(home, {
      query: 'ruvnet: how does the ecosystem organize its repos?',
      toolResponse: 'Searched 3 RuvNet repos (ruvnet, ruflo, agentdb).\n#1 repo=ruvnet\n----- full document (200 chars) -----\nreal source',
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.cache/ruvnet-brain/grounded/ruvnet'))).toBe(true);
  });

  it('a query naming NO recognised product term still mints evidence via the any-search marker (RED pre-fix: nothing minted)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-generic-'));
    const r = fireStamp(home, {
      query: 'how should agent handoffs stay consistent across a long session',
      toolResponse: 'Searched 5 RuvNet repos (misc).\n#1 repo=ruflo\n----- full document (200 chars) -----\nreal source',
    });
    expect(r.status).toBe(0);
    const groundedDir = path.join(home, '.cache/ruvnet-brain/grounded');
    const entries = fs.existsSync(groundedDir) ? fs.readdirSync(groundedDir) : [];
    expect(entries.length, 'grounding-stamp.sh minted no evidence at all for a genuinely successful search').toBeGreaterThan(0);
  });

  it('a refusal still mints NOTHING, not even the any-search marker (the any-search fix must not reopen ADR-054 gate 3)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-refusal-'));
    fireStamp(home, {
      query: 'ruvnet: how does the ecosystem organize its repos?',
      toolResponse: 'RuvNet Brain is disabled by this user\'s own setting. No search was run.',
    });
    const groundedDir = path.join(home, '.cache/ruvnet-brain/grounded');
    expect(fs.existsSync(groundedDir) ? fs.readdirSync(groundedDir) : []).toEqual([]);
  });
});

describe.skipIf(!hasBash || process.platform === 'win32')('end-to-end: the exact GitHub #316 repro, mark -> stamp -> gate', () => {
  it('a prompt about "ruvnet" that IS followed by a real search_ruvnet("ruvnet: ...") call leaves the Stop gate silent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-316-'));
    const env = { ...process.env, HOME: home, RUVNET_HOOK_HOST: 'claude', RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn') };

    const markResult = spawnSync(process.execPath, [MARK], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-316', prompt: 'what does ruvnet actually ship?' }),
      encoding: 'utf8', env,
    });
    expect(markResult.status).toBe(0);
    expect(fs.existsSync(markerPathFor('sess-316', env.RUVNET_GROUNDING_TURN_DIR))).toBe(true);

    const stampResult = fireStamp(home, {
      query: 'ruvnet: what does it actually ship?',
      toolResponse: 'Searched 3 RuvNet repos (ruvnet).\n#1 repo=ruvnet\n----- full document (200 chars) -----\nreal source',
    });
    expect(stampResult.status).toBe(0);

    const gateResult = spawnSync(process.execPath, [GATE], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-316', stop_hook_active: false }),
      encoding: 'utf8', env,
    });
    expect(gateResult.status).toBe(0);
    // RED on pre-fix code: this would be the "no successful search_ruvnet this turn" block message.
    expect(gateResult.stdout).toBe('');
  });
});
