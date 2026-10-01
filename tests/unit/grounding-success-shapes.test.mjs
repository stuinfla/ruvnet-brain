// tests/unit/grounding-success-shapes.test.mjs
//
// THE FALSE ALARM, REPRODUCED ON REAL DATA (2026-09-30). The Stop hook (grounding-turn-gate) said
// "no successful search_ruvnet call was recorded this turn" on turns where search_ruvnet HAD
// answered. Earlier fixes (H1 / #316, ADR-0030 #1) repaired the vocabulary and the boundary; this is
// a third, independent cause: the SUCCESS PREDICATE. Both graders (grounding-stamp.sh at PostToolUse,
// grounding-turn-evidence.mjs sourceOf at Stop) decided "did the brain answer?" by one substring,
// `Searched <n> RuvNet repos`, which only the HEAVY lane prints. Measured over 240 real search_ruvnet
// results in this project's Claude transcripts: 43 (18%) carry no such banner, and 22 of those are
// real answers that were graded as failures:
//   - 12  the HOST replaced an oversized result with
//         "Error: result (N characters) exceeds maximum allowed tokens. Output has been saved to <file>"
//         (PostToolUse AND the transcript both carry that error text, never the banner — reproduced
//         live with a real `claude -p` turn, payload in tests/fixtures/hook-payloads/claude);
//   - 10  the FAST LANE (kb/card-lane.mjs renderCardHit): "evidence=curated-capability-card", the
//         zero-ML first responder that answers most capability questions — it never prints the banner.
// What stays a non-answer, and must: "NO SEARCH WAS RUN" (router declined), the switched-off soft
// answer, the GONG, a thrown error, and an oversized result whose saved file holds no answer.
//
// Every assertion below runs a REAL subprocess (bash grounding-stamp.sh, node grounding-turn-gate.mjs)
// in a throwaway HOME with REAL-shaped payloads (captured from claude 2.1.286) and the REAL renderers
// (kb/card-lane.mjs, kb/search-outcome.mjs) — nothing is typed from memory.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderCardHit } from '../../kb/card-lane.mjs';
import { describeSearchOutcome } from '../../kb/search-outcome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAMP = path.join(ROOT, 'plugin', 'scripts', 'grounding-stamp.sh');
const MARK = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-mark.mjs');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-gate.mjs');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'hook-payloads', 'claude');
const TOOL = 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet';
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

const BANNERED = 'Searched 1 RuvNet repos (ruflo).\nCorpus snapshot ages: newest store 3.2d old.\n#1  repo=ruflo  (relevance 0.9)\npath : ruflo/docs/x.md\ntitle: x\n';
const CARD = renderCardHit({ repo: 'ruflo', path: 'capability-cards.md#ruflo', text: 'Ruflo is the orchestration layer.', namedRepo: true, bodyOverlap: 3, coverage: 1 });
const DECLINED = describeSearchOutcome({ repos: [], routing: { attempted: true, accepted: false, reason: 'nothing over threshold' }, installedRepoCount: 30 }).header;
const EMPTY = 'Searched 0 RuvNet repos ()\n(no results — the search ran; nothing in the corpus matched this query)';

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-'));
  const cwd = path.join(home, 'cwd'); fs.mkdirSync(cwd);
  const transcriptDir = path.join(home, '.claude', 'projects', 'p', 'sess-1');
  fs.mkdirSync(path.join(transcriptDir, 'tool-results'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn'),
    RUVNET_ASSERTION_SHADOW_LOG: path.join(home, 'shadow.jsonl'), RUVNET_KB_DIR: path.join(home, 'no-kb'), RUVNET_HOOK_HOST: '' };
  delete env.RUVNET_BRAIN_HOME;
  return { home, cwd, transcriptDir, transcript: `${transcriptDir}.jsonl`, env };
}
function fixture(name, w, overrides = {}) {
  const raw = fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8');
  const s = raw.split('{{TRANSCRIPT_DIR}}').join(w.transcriptDir).split('{{TRANSCRIPT}}').join(w.transcript)
    .split('{{CWD}}').join(w.cwd).split('{{SESSION_ID}}').join('sess-1').split('{{PROMPT_ID}}').join('p1')
    .split('{{TOOL_USE_ID}}').join('toolu_1').split('{{HOME}}').join(w.home);
  return { ...JSON.parse(s).payload, ...overrides };
}
/** The real oversize payload, with the host's saved-result file written beside the transcript. */
function oversizePayload(w, savedContent) {
  const p = fixture('PostToolUse-search_ruvnet-oversize', w);
  const m = /saved to (\S+?\.txt)/.exec(p.tool_response);
  fs.mkdirSync(path.dirname(m[1]), { recursive: true });
  if (savedContent !== null) fs.writeFileSync(m[1], JSON.stringify({ answer: savedContent }));
  return p;
}
const stamp = (w, payload) => spawnSync('bash', [STAMP], { input: JSON.stringify(payload), env: w.env, encoding: 'utf8', timeout: 15_000 });
const minted = (w) => { const d = path.join(w.home, '.cache', 'ruvnet-brain', 'grounded'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const node = (file, w, payload) => spawnSync(process.execPath, [file], { input: JSON.stringify(payload), env: w.env, encoding: 'utf8', timeout: 15_000 });

/** A Claude JSONL transcript: prompt, one search_ruvnet call with the given RESULT, the final answer. */
function writeTranscript(w, result) {
  const rows = [
    { type: 'user', message: { role: 'user', content: 'what does ruflo ship for memory?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: TOOL, input: { query: 'ruflo memory' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: result }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ruflo ships AgentDB-backed memory.' }] } },
  ];
  fs.writeFileSync(w.transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
/** UserPromptSubmit marker, then the REAL Stop payload shape, through the real gate. */
function stopGate(w, result) {
  node(MARK, w, fixture('UserPromptSubmit', w, { prompt: 'what does ruflo ship for memory?' }));
  writeTranscript(w, result);
  return node(GATE, w, fixture('Stop', w, { last_assistant_message: 'Ruflo ships AgentDB-backed memory.' }));
}
const FALSE_ALARM = /no successful(?:\s|\\n)+search_ruvnet call/;

describe.skipIf(!hasBash || process.platform === 'win32')('PostToolUse grounding-stamp: what counts as the brain having answered', () => {
  it('a FAST-LANE (curated capability card) answer mints the any-search evidence', () => {
    const w = world();
    const p = fixture('PostToolUse-search_ruvnet-oversize', w, { tool_response: JSON.stringify({ answer: CARD }) });
    expect(stamp(w, p).status).toBe(0);
    expect(minted(w)).toContain('.any-search');
  });

  it('the host-replaced OVERSIZE result mints evidence when the saved file holds the brain\'s real answer', () => {
    const w = world();
    const p = oversizePayload(w, BANNERED);
    expect(p.tool_response).toMatch(/^Error: result \([\d,]+ characters\) exceeds maximum allowed tokens\. Output has been saved to /);
    expect(stamp(w, p).status).toBe(0);
    expect(minted(w)).toContain('.any-search');
    expect(minted(w)).toContain('ruflo');   // the QUERY still decides which product term
  });

  it('TEETH: an oversize error whose saved file is missing, empty of an answer, or outside tool-results mints NOTHING', () => {
    const missing = world(); expect(stamp(missing, oversizePayload(missing, null)).status).toBe(0);
    expect(minted(missing)).toEqual([]);
    const noAnswer = world(); stamp(noAnswer, oversizePayload(noAnswer, 'search_ruvnet error: boom'));
    expect(minted(noAnswer)).toEqual([]);
    const outside = world();
    const p = oversizePayload(outside, null);
    const elsewhere = path.join(outside.home, 'elsewhere.txt'); fs.writeFileSync(elsewhere, JSON.stringify({ answer: BANNERED }));
    p.tool_response = p.tool_response.replace(/saved to \S+?\.txt/, `saved to ${elsewhere}`);
    stamp(outside, p);
    expect(minted(outside), 'a forged path outside the host tool-results directory must not open the gate').toEqual([]);
  });

  it('TEETH: every genuine non-answer still mints nothing (router decline, empty result, outage, disabled, error)', () => {
    for (const bad of [DECLINED, EMPTY, 'RUVNET BRAIN IS DOWN — every repo failed', 'RuvNet Brain is disabled by this user\'s own setting.', 'search_ruvnet error: boom']) {
      const w = world();
      stamp(w, fixture('PostToolUse-search_ruvnet-oversize', w, { tool_response: JSON.stringify({ answer: bad }) }));
      expect(minted(w), `minted evidence for a non-answer: ${bad.slice(0, 40)}`).toEqual([]);
    }
  });

  it('a REAL answer whose retrieved document merely QUOTES a refusal phrase is still an answer', () => {
    // The corpus includes this repo's own docs, which quote these exact strings.
    for (const quoted of ['RUVNET BRAIN IS DOWN', 'RuvNet Brain is disabled', 'search_ruvnet error:', '(no results — the search ran']) {
      const w = world();
      const body = `${BANNERED}----- full document -----\nThe alarm prints "${quoted}" when every repo fails.\n`;
      stamp(w, fixture('PostToolUse-search_ruvnet-oversize', w, { tool_response: JSON.stringify({ answer: body }) }));
      expect(minted(w), `a real answer that quotes "${quoted}" was discarded`).toContain('.any-search');
    }
  });
});

describe.skipIf(process.platform === 'win32')('Stop grounding-turn-gate on a real Claude transcript', () => {
  it('silent after a FAST-LANE answer (the false alarm, #1)', () => {
    const w = world();
    const r = stopGate(w, JSON.stringify({ answer: CARD }));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(FALSE_ALARM);
    expect(r.stdout).toBe('');
  });

  it('silent after an OVERSIZE result the host replaced with an error, when the saved file holds the answer (the false alarm, #2)', () => {
    const w = world();
    const p = oversizePayload(w, BANNERED);
    const r = stopGate(w, p.tool_response);
    expect(r.stdout).toBe('');
  });

  it('TEETH: still FIRES after a router decline, an oversize error with no saved answer, and an outright error', () => {
    const w1 = world();
    expect(stopGate(w1, JSON.stringify({ answer: DECLINED })).stdout).toMatch(FALSE_ALARM);
    const w2 = world();
    expect(stopGate(w2, oversizePayload(w2, null).tool_response).stdout).toMatch(FALSE_ALARM);
    const w3 = world();
    expect(stopGate(w3, 'search_ruvnet error: boom').stdout).toMatch(FALSE_ALARM);
  });
});

describe.skipIf(process.platform === 'win32')('Stop grounding-turn-gate on a LONG turn (the transcript tail no longer reaches the turn start)', () => {
  it('a real search early in a >2 MiB turn is not reported as "no search" just because the tail cut it off (false alarm #3)', () => {
    const w = world();
    const rows = [
      { type: 'user', message: { role: 'user', content: 'what does ruflo ship for memory?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: TOOL, input: { query: 'ruflo memory' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ answer: BANNERED }) }] } },
    ];
    for (let i = 0; i < 30; i++) {   // 30 x 100 KB of later tool output pushes the turn start out of the 2 MiB tail
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'cat big' } }] } });
      rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, content: 'x'.repeat(100_000) }] } });
    }
    rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ruflo ships AgentDB-backed memory.' }] } });
    fs.writeFileSync(w.transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(fs.statSync(w.transcript).size).toBeGreaterThan(2 * 1024 * 1024);
    node(MARK, w, fixture('UserPromptSubmit', w, { prompt: 'what does ruflo ship for memory?' }));
    // The tail cannot see the early search, so the gate falls back to the STAMP evidence (4.4.0: never a
    // silent pass). The early search's PostToolUse ran the real stamp hook, which minted it.
    stamp(w, fixture('PostToolUse-search_ruvnet-oversize', w, { tool_input: { query: 'ruflo memory' }, tool_response: JSON.stringify({ answer: BANNERED }) }));
    expect(minted(w)).toContain('.any-search');
    const r = node(GATE, w, fixture('Stop', w, { last_assistant_message: 'Ruflo ships AgentDB-backed memory.' }));
    expect(r.stdout).toBe('');
  });

  it('TEETH: the same long turn with NO search evidence anywhere FIRES — the tail is not a free pass', () => {
    const w = world();
    const rows = [{ type: 'user', message: { role: 'user', content: 'what does ruflo ship for memory?' } }];
    for (let i = 0; i < 30; i++) {
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'cat big' } }] } });
      rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, content: 'x'.repeat(100_000) }] } });
    }
    rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ruflo ships AgentDB-backed memory.' }] } });
    fs.writeFileSync(w.transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    node(MARK, w, fixture('UserPromptSubmit', w, { prompt: 'what does ruflo ship for memory?' }));
    const r = node(GATE, w, fixture('Stop', w, { last_assistant_message: 'Ruflo ships AgentDB-backed memory.' }));
    expect(r.stdout).toMatch(FALSE_ALARM);
  });
});

describe.skipIf(!hasBash || process.platform === 'win32')('Codex host keeps the stamp as its evidence (its rollout is not parsed)', () => {
  it('a fast-lane answer in Codex\'s tool_response object shape mints evidence; a decline does not', () => {
    const ok = world();
    stamp(ok, { hook_event_name: 'PostToolUse', tool_name: 'mcp__ruvnet_brain__search_ruvnet', tool_input: { query: 'ruflo' }, tool_response: { content: [{ type: 'text', text: CARD }] } });
    expect(minted(ok)).toContain('.any-search');
    const no = world();
    stamp(no, { hook_event_name: 'PostToolUse', tool_name: 'mcp__ruvnet_brain__search_ruvnet', tool_input: { query: 'ruflo' }, tool_response: { content: [{ type: 'text', text: DECLINED }] } });
    expect(minted(no)).toEqual([]);
  });
});
