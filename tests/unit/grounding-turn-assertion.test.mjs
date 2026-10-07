import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { armFor, markerPathFor, readMarker, writeArm } from '../../plugin/scripts/grounding-turn-mark.mjs';
import {
  architectureShadow, auditAssertions, bindingSources, classifyPrompt, relayShadow, sourceOf, turnSources,
} from '../../plugin/scripts/grounding-turn-evidence.mjs';
import { extractClaims } from '../../plugin/scripts/capability-claim-evidence.mjs';

/**
 * ADR-0030 decision point #1 at prompt time + the grounding-turn-gate false alarm. Real subprocesses,
 * a throwaway HOME, synthetic Claude JSONL transcripts; nothing touches the real ~/.cache or ~/.claude.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARK = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-mark.mjs');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-gate.mjs');
const VOCAB = ['hook', 'hooks', 'ruflo', 'metaharness', 'claude code', 'codex', 'webfetch'];

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-assert-'));
  return { home, env: { HOME: home, USERPROFILE: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn'),
    RUVNET_ASSERTION_SHADOW_LOG: path.join(home, 'shadow.jsonl'), RUVNET_KB_DIR: path.join(home, 'no-kb'), RUVNET_HOOK_HOST: 'claude' } };
}
const run = (file, payload, env) => spawnSync(process.execPath, [file], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000 });
const stamp = (home, term) => { const d = path.join(home, '.cache', 'ruvnet-brain', 'grounded'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, term), ''); };

/** A Claude JSONL transcript: prompt, then [name, input, result] tool calls, then the final answer. */
function transcript(dir, prompt, calls, answer) {
  const rows = [{ type: 'user', message: { role: 'user', content: prompt } }];
  calls.forEach(([name, input, result, evidence = { is_error: false }], i) => {
    rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input }] } });
    rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: result, ...evidence }] } });
  });
  rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const SEARCH_OK = 'Searched 1 RuvNet repos (ruflo).\n#1  repo=ruflo\npath : ruflo/docs/hooks.md\ntitle: hooks';

const INCIDENT_PROMPT = 'I need the best model for hard questions and a cheap model for the rest. Can a hook force which model answers each prompt? Figure out the best way with metaharness and ruflo.';
const INCIDENT_ANSWER = [
  '## What a hook can and can\'t do',
  'I checked the live hook documentation.',
  '- **No hook can change the model of the current turn.** A prompt hook can inject context or block the prompt.',
].join('\n');
const INCIDENT_CALLS = [
  ['Bash', { command: 'cat docs/adr/0015-self-optimizing-router-profiles.md', description: 'Read routing ADRs' }, 'router profiles'],
  ['mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet', { query: 'metaharness cascade model routing' }, 'Searched 1 RuvNet repos (metaharness).\npath : metaharness/docs/PLACEMENT.md'],
  ['WebFetch', { url: 'https://code.claude.com/docs/en/hooks', prompt: 'Can any hook change the model?' }, 'No hook event can directly change the model.'],
  ['Bash', { command: 'curl -s https://openrouter.ai/api/v1/models', description: 'Pull live models' }, 'anthropic/claude-opus-5.5'],
];

describe('the false alarm, reproduced (grounding-turn-gate said "no search" after a real one)', () => {
  it('a QUEUED mid-turn prompt after the search no longer moves the turn boundary past it', () => {
    // Measured cause (3 of 7 real false alarms): UserPromptSubmit fired again for a message typed
    // mid-turn, AFTER search_ruvnet had stamped, and re-dated the marker. Red on release/4.3.38.
    const { home, env } = sandbox();
    const sid = 'queued-1';
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt_id: 'queued-native-prompt', prompt: 'use ruflo memory for this' }, env);
    const marker = markerPathFor(sid, env.RUVNET_GROUNDING_TURN_DIR);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(marker, past, past);                 // the prompt arrived a minute ago
    stamp(home, 'ruflo');                               // the search happened 30s ago
    fs.utimesSync(path.join(home, '.cache', 'ruvnet-brain', 'grounded', 'ruflo'), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt_id: 'queued-native-prompt', prompt: 'and what about ruvector?' }, env); // queued now
    expect(Math.abs(fs.statSync(marker).mtimeMs - past.getTime())).toBeLessThan(1500);
    expect(readMarker(marker).subjects).toContain('ruvector');   // merged, not lost
    const gate = run(GATE, { hook_event_name: 'Stop', session_id: sid, prompt_id: 'queued-native-prompt', stop_hook_active: false }, env);
    expect(gate.status).toBe(0);
    expect(gate.stdout).toBe('');
  });

  it('a successful search in the TRANSCRIPT satisfies Gate 1 even when no stamp was minted', () => {
    const { home, env } = sandbox();
    const tp = transcript(home, 'use ruflo memory', [['mcp__ruvnet-brain__search_ruvnet', { query: 'ruflo memory' }, SEARCH_OK]], 'Done reading.');
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'use ruflo memory' }, env);
    const gate = run(GATE, { hook_event_name: 'Stop', session_id: 's2', transcript_path: tp, last_assistant_message: 'Done reading.' }, env);
    expect(gate.stdout).toBe('');
  });

  // 4.4.0: Gate 1 fires only when the answer ASSERTS a rUv capability (tests/unit/grounding-turn-false-alarm.test.mjs).
  it('with no search in the transcript it still fires on a rUv capability claim, and says what WAS read', () => {
    const { home, env } = sandbox();
    const tp = transcript(home, 'use ruflo memory', [['Read', { file_path: '/repo/README.md' }, 'text']], 'Ruflo stores memory in AgentDB.');
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 's3', prompt: 'use ruflo memory' }, env);
    const gate = run(GATE, { hook_event_name: 'Stop', session_id: 's3', transcript_path: tp, last_assistant_message: 'Ruflo stores memory in AgentDB.' }, env);
    const ctx = JSON.parse(gate.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/search_ruvnet/);
    expect(ctx).toMatch(/Read "\/repo\/README\.md"/);
  });

  it('a search_ruvnet that FAILED (outage banner) does not count', () => {
    expect(sourceOf('mcp__x__search_ruvnet', { query: 'ruflo' }, 'RUVNET BRAIN IS DOWN — all repos failed').ok).toBe(false);
    expect(sourceOf('mcp__x__search_ruvnet', { query: 'ruflo' }, SEARCH_OK, { resultEvidence: { type: 'tool_result', tool_use_id: 'search', is_error: false } }).ok).toBe(true);
  });
});

describe('ADR-0030 #1 — capability claims need a relevant, strong source read this turn', () => {
  it('REPLAY OF THE INCIDENT: a claim from a WebFetch summary is blocked, once, naming the claim and the weak source', () => {
    const { home, env } = sandbox();
    const tp = transcript(home, INCIDENT_PROMPT, INCIDENT_CALLS, INCIDENT_ANSWER);
    const mark = run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 'inc', prompt: INCIDENT_PROMPT }, env);
    expect(mark.status).toBe(0);
    expect(readMarker(markerPathFor('inc', env.RUVNET_GROUNDING_TURN_DIR))).toMatchObject({ assert: true });
    const payload = { hook_event_name: 'Stop', session_id: 'inc', transcript_path: tp, last_assistant_message: INCIDENT_ANSWER };
    const gate = run(GATE, payload, env);
    const ctx = JSON.parse(gate.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/You asserted "No hook can change the model of the current turn\." about hook/);
    expect(ctx).toMatch(/WebFetch "https:\/\/code\.claude\.com\/docs\/en\/hooks" \[summarised-by-small-model = weak evidence\]/);
    expect(ctx).toMatch(/restate each claim as UNVERIFIED/);
    expect(ctx).not.toMatch(/What a hook can and can't do/);   // a heading is not a claim
    // ONE block per turn: the marker is consumed, and the continued stop is silent.
    expect(run(GATE, payload, env).stdout).toBe('');
    expect(run(GATE, { ...payload, stop_hook_active: true }, env).stdout).toBe('');
  });

  it('a STRONG source about the subject read AFTER the summary clears it', () => {
    const calls = [...INCIDENT_CALLS, ['Read', { file_path: '/docs/claude-code/hooks.md' }, 'Hooks run lifecycle handlers and cannot change the active model.']];
    const turn = turnSources(fs.readFileSync(transcript(sandbox().home, INCIDENT_PROMPT, calls, INCIDENT_ANSWER), 'utf8').split('\n'));
    const audit = auditAssertions({ message: INCIDENT_ANSWER, subjects: ['hooks'], vocab: VOCAB, sources: turn.sources });
    expect(audit.claims.length).toBeGreaterThan(0);
    expect(audit.findings).toEqual([]);
  });

  it('ORDER matters: the same strong source read BEFORE the summary does not clear it', () => {
    const calls = [['Read', { file_path: '/docs/claude-code/hooks.md' }, 'Hooks run lifecycle handlers and cannot change the active model.'], ...INCIDENT_CALLS];
    const turn = turnSources(fs.readFileSync(transcript(sandbox().home, INCIDENT_PROMPT, calls, INCIDENT_ANSWER), 'utf8').split('\n'));
    expect(auditAssertions({ message: INCIDENT_ANSWER, subjects: ['hooks'], vocab: VOCAB, sources: turn.sources }).findings.length).toBeGreaterThan(0);
  });

  it('RELEVANCE matters: a strong source about something else does not clear it', () => {
    const sources = [{ ...sourceOf('Read', { file_path: '/repo/scripts/model-router-engine.mjs' }, 'router'), order: 0 }];
    expect(auditAssertions({ message: 'No hook can change the model.', subjects: ['hook'], vocab: VOCAB, sources }).findings).toHaveLength(1);
  });

  it('hedged or UNVERIFIED restatements, questions and headings are not claims', () => {
    for (const m of ['UNVERIFIED: no hook can change the model.', 'A hook probably cannot change the model.',
      'Can a hook change the model?', '## What a hook can and can\'t do']) {
      expect(auditAssertions({ message: m, subjects: ['hook'], vocab: VOCAB, sources: [] }).findings, m).toEqual([]);
    }
  });

  it('an UNARMED turn (no capability question) is never judged, whatever the answer says', () => {
    const { home, env } = sandbox();
    const prompt = 'please commit the release branch';
    expect(armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'u', prompt }, VOCAB)).toBeNull();
    const tp = transcript(home, prompt, [], 'No hook can change the model.');
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 'u', prompt }, env);
    expect(run(GATE, { hook_event_name: 'Stop', session_id: 'u', transcript_path: tp, last_assistant_message: 'No hook can change the model.' }, env).stdout).toBe('');
  });

  it('classifies capability / architecture questions about any platform, not only rUv', () => {
    expect(classifyPrompt('Can GitHub Actions run on a schedule with `workflow_dispatch`?', VOCAB)).toMatchObject({ assert: true });
    expect(classifyPrompt('What is the best architecture for hooks here?', VOCAB)).toMatchObject({ assert: true, architecture: true });
    expect(classifyPrompt('thanks, that works', VOCAB).assert).toBe(false);
  });

  it('Codex (transcript not parsed): an rUv subject needs a stamp; a non-rUv subject is UNKNOWN, never blocked', () => {
    // (A "Ruflo …" claim would be continuation-gate's RUVNET_TOOL class, so metaharness is used here.)
    const noStamp = auditAssertions({ message: 'MetaHarness cannot route models.', subjects: ['metaharness'], vocab: VOCAB, sources: null, stampTerms: [] });
    expect(noStamp.findings).toHaveLength(1);
    expect(auditAssertions({ message: 'MetaHarness cannot route models.', subjects: ['metaharness'], vocab: VOCAB, sources: null, stampTerms: ['metaharness'] }).findings).toEqual([]);
    const other = auditAssertions({ message: 'No hook can change the model.', subjects: ['hook'], vocab: VOCAB, sources: null });
    expect(other.findings).toEqual([]);
    expect(other.unknown).toHaveLength(1);
  });

  it('continuation-gate keeps its own RUVNET_TOOL claims: the default extractor scope is unchanged', () => {
    expect(extractClaims('Ruflo supports routing. A hook can block the prompt.').map((c) => c.tool)).toEqual(['Ruflo']);
    expect(extractClaims('A hook can block the prompt.', { tools: ['hook'] }).map((c) => c.tool)).toEqual(['hook']);
  });

  it('BREAK-IT: if WebFetch were trusted as a strong source, the incident would pass — so it must be weak', () => {
    const fetch = { ...sourceOf('WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }, 'Hooks cannot change the model according to this generated summary.', { resultEvidence: { type: 'tool_result', tool_use_id: 'summary', is_error: false } }), order: 0 };
    expect(fetch.strength).toBe('weak');
    expect(bindingSources('hook', [fetch])).toHaveLength(1);
    expect(auditAssertions({ message: 'No hook can change the model.', subjects: ['hook'], vocab: VOCAB, sources: [fetch] }).findings).toHaveLength(1);
    expect(auditAssertions({ message: 'No hook can change the model.', subjects: ['hook'], vocab: VOCAB, sources: [{ ...fetch, strength: 'strong' }] }).findings).toEqual([]);
  });

  it('an unreadable transcript remains UNKNOWN despite shared stamps, a missing marker is silence', () => {
    const { home, env } = sandbox();
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 'fo', prompt: 'can ruflo route models?' }, env);
    stamp(home, 'ruflo');
    const gate = run(GATE, { hook_event_name: 'Stop', session_id: 'fo', transcript_path: path.join(home, 'missing.jsonl'), last_assistant_message: 'Ruflo cannot route models.' }, env);
    expect(gate.status).toBe(0);
    expect(gate.stdout).toMatch(/UNKNOWN/); // shared product freshness is not current-turn evidence
    expect(run(GATE, { hook_event_name: 'Stop', session_id: 'never-marked' }, env).stdout).toBe('');
  });

  it('writeArm keeps the first arm of an episode but replaces a stale one', () => {
    const { home } = sandbox();
    const file = path.join(home, 'm.json');
    writeArm(file, { gate1: true, assert: false, architecture: false, subjects: ['ruflo'] });
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(file, old, old);
    writeArm(file, { gate1: false, assert: true, architecture: false, subjects: ['hook'] });
    expect(readMarker(file)).toMatchObject({ gate1: false, assert: true, subjects: ['hook'] });
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(5000);
  });
});

describe('ADR-0030 #2/#3 — SHADOW only: logged, never delivered', () => {
  it('an architecture recommendation with fewer than 3 options is logged, and the gate stays silent about it', () => {
    const { home, env } = sandbox();
    const prompt = 'What architecture should we use for hooks routing?';
    const answer = 'I recommend a single Stop gate. Option A is simple.';
    expect(architectureShadow({ architecture: true, message: answer })).toMatchObject({ wouldBlock: true });
    expect(architectureShadow({ architecture: true, message: `${answer}\nOption A x\nOption B y\nOption C z` })).toBeNull();
    const tp = transcript(home, prompt, [['Read', { file_path: '/repo/hooks/hooks.json' }, '{}']], answer);
    run(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 'sh', prompt }, env);
    const gate = run(GATE, { hook_event_name: 'Stop', session_id: 'sh', transcript_path: tp, last_assistant_message: answer }, env);
    expect(gate.stdout).toBe('');
    expect(fs.readFileSync(env.RUVNET_ASSERTION_SHADOW_LOG, 'utf8')).toMatch(/adr-0030-2-architecture-options/);
  });

  it('a number relayed from a subagent without a re-check is detected; re-reading the artifact clears it', () => {
    const agent = { ...sourceOf('Agent', { description: 'score it' }, 'Final score: 87.5/100', { resultEvidence: { type: 'tool_result', tool_use_id: 'agent', is_error: false } }), order: 0 };
    expect(relayShadow({ message: 'The score is 87.5/100.', sources: [agent] })).toMatchObject({ numbers: ['87.5/100'] });
    const reread = { ...sourceOf('Bash', { command: 'cat score.json' }, '{"score":"87.5/100"}\nExit code: 0', { resultEvidence: { type: 'tool_result', tool_use_id: 'read-score', is_error: false, content: '{"score":"87.5/100"}\nExit code: 0' } }), order: 1 };
    expect(relayShadow({ message: 'The score is 87.5/100.', sources: [agent, reread] })).toBeNull();
  });
});

describe('grounding requires observed successful substantive source content', () => {
  const claim = 'No hook can change the model.';
  const body = '# Hook documentation\nHooks run lifecycle handlers and cannot change the active model.';
  const observed = (extra = {}) => ({ type: 'tool_result', tool_use_id: 'source', is_error: false, ...extra });
  const audit = sources => auditAssertions({ message: claim, subjects: ['hook'], vocab: VOCAB, sources });
  it.each([
    ['failed', body, { is_error: true }, 'failed'],
    ['missing', '', null, 'unknown'],
    ['declared failure', body, observed({ status: 'failed' }), 'failed'],
    ['declared unknown', body, observed({ status: 'unknown' }), 'unknown'],
    ['absent completion flags', body, { type: 'tool_result', tool_use_id: 'source' }, 'unknown'],
    ['running', body, observed({ content: { status: 'running' } }), 'unknown'],
  ])('%s Read result never becomes strong from its requested path', (_name, content, evidence, strength) => {
    const source = { ...sourceOf('Read', { file_path: '/docs/hooks.md' }, content, { resultEvidence: evidence }), order: 0 };
    expect(source.strength).toBe(strength); expect(audit([source]).findings).toHaveLength(1);
  });
  it('turnSources preserves failed native result flags even when the body contains matching documentation', () => {
    const f = sandbox(); const file = transcript(f.home, 'Can hooks change the model?', [['Read', { file_path: '/docs/hooks.md' }, body, { is_error: true }]], claim);
    const turn = turnSources(fs.readFileSync(file, 'utf8').split('\n'));
    expect(turn.sources[0]).toMatchObject({ strength: 'failed', terminalOutcome: 'fail' });
    expect(audit(turn.sources).findings).toHaveLength(1);
  });
  it('a tool_use with no matching result remains UNKNOWN, never a strong source', () => {
    const lines = [{ type: 'user', message: { role: 'user', content: 'Can hooks change the model?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'not-returned', name: 'Read', input: { file_path: '/docs/hooks.md' } }] } }].map(row => JSON.stringify(row));
    const turn = turnSources(lines); expect(turn.sources[0].strength).toBe('unknown'); expect(audit(turn.sources).findings).toHaveLength(1);
  });
  it('a genuinely returned Read body binds the subject, while a matching requested path with unrelated contents does not', () => {
    const f = sandbox(), file = path.join(f.home, 'hooks.md'); fs.writeFileSync(file, body);
    const source = { ...sourceOf('Read', { file_path: file }, fs.readFileSync(file, 'utf8'), { resultEvidence: observed() }), order: 0 };
    expect(source).toMatchObject({ strength: 'strong', terminalOutcome: 'unknown', successEvidence: 'native-read-success' });
    expect(audit([source]).findings).toEqual([]);
    const unrelated = { ...sourceOf('Read', { file_path: '/docs/hooks.md' }, 'A router selects task priorities and processes its queue.', { resultEvidence: observed() }), order: 0 };
    expect(bindingSources('hook', [unrelated])).toEqual([]); expect(audit([unrelated]).findings).toHaveLength(1);
  });
  it.each(['echo "Hooks can change the model"', 'printf "Hooks run lifecycle handlers"', 'cat /docs/hooks.md; echo Hook'])('arbitrary or compound Bash %s cannot launder requested or echoed subject text', command => {
    const source = { ...sourceOf('Bash', { command }, body + '\nExit code: 0', { resultEvidence: observed({ content: body + '\nExit code: 0' }) }), order: 0 };
    expect(source.strength).not.toBe('strong'); expect(audit([source]).findings).toHaveLength(1);
  });
  it('a literal direct file read requires explicit terminal zero and matching substantive returned body', () => {
    const source = { ...sourceOf('Bash', { command: 'cat /docs/hooks.md' }, body + '\nExit code: 0', { resultEvidence: observed({ content: body + '\nExit code: 0' }) }), order: 0 };
    expect(source).toMatchObject({ strength: 'strong', terminalOutcome: 'pass' }); expect(audit([source]).findings).toEqual([]);
    const pending = sourceOf('Bash', { command: 'cat /docs/hooks.md' }, body, { resultEvidence: observed({ content: body }) });
    expect(pending).toMatchObject({ strength: 'unknown', terminalOutcome: 'unknown' });
  });
  it('bare returned paths or one-word echoes do not provide substantive source content', () => {
    for (const content of ['/docs/hooks.md', 'hook']) {
      const source = { ...sourceOf('Read', { file_path: '/docs/hooks.md' }, content, { resultEvidence: observed() }), order: 0 };
      expect(source.strength).not.toBe('strong'); expect(audit([source]).findings).toHaveLength(1);
    }
  });
  it('an errored search cannot satisfy the search gate merely by returning an answer banner', () => {
    const source = sourceOf('mcp__x__search_ruvnet', { query: 'ruflo' }, SEARCH_OK, { resultEvidence: observed({ is_error: true }) });
    expect(source).toMatchObject({ strength: 'failed', ok: false });
  });
});

it('the classifier uses the actual native returned body rather than an inconsistent supplied copy', () => {
  const content = 'A router chooses priorities and maintains a queue.';
  const source = sourceOf('Read', { file_path: '/docs/hooks.md' }, 'Hooks support lifecycle handlers and prompt blocking.',
    { resultEvidence: { type: 'tool_result', tool_use_id: 'actual', is_error: false, content } });
  expect(bindingSources('hook', [source])).toEqual([]); expect(source.result).toBe(content);
});
