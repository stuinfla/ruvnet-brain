// agentdb-first-gate.test.mjs — ALWAYS CHECK AGENTDB FIRST, the Stop half (ADR-0101, owner R15).
// The score detector is held by positive and negative corpora (the negatives are the shapes measured on
// real transcripts by scripts/agentdb-first-replay.mjs: counts, targets, similarity scores, recall@k);
// decide() and the real process are driven with Claude transcripts and Codex rollouts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scoreAssertions, readsAgentdb, claudeTurnCalls, codexTurnCalls, decide } from '../../plugin/scripts/agentdb-first-gate.mjs';
import { fakeWorld } from '../helpers/agentdb-fake-ruflo.mjs';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/agentdb-first-gate.mjs');
const SHIM = path.resolve(import.meta.dirname, '../../plugin/scripts/hook-shim.mjs');

const SCORES = [
  'Overall: 46/100',
  'I would score it 46/100.',
  '**North Star: 31/100** after the fixes',
  'My rating: 6.5 out of 10.',
  'Grade: B+',
  'overall 72%',
  'Estimated North Star jump: 33.5/100 → 75/100',
  '| **OVERALL** | **71/100** | gap |',
  '### CONTINUITY 68/100 — execution miss',
  '- **Projected mean: 56.6/100**',
  '| Pillar | Score |\n|---|---|\n| Retrieval | 40 |\n| Learning | 22 |',
];
const NOT_SCORES = [
  'Tests: 87/100 passed.',
  '334/334 turns replayed, 0 false positives',
  'recall@10 = 0.98 of the sample (98/100 stores retrieved)',
  'Similarity score 0.63 for north-star-reconciliation',
  'Target: North Star 95/100+ (all pillars ≥70)',
  'Ship if >90/100 on Tuesday',
  'We need 95/100 before release.',
  '4-5 days to 95/100 proof',
  'Are you okay with 65/100 as a realistic North Star?',
  '## HOW THIS AFFECTS OPTION A (NORTH STAR 98/100)',
  'Hit@5 was 162/182 = 89.0%',
  'Coverage is 85% on the unit suite.',
  'The upgrade grade a file system migration',
  'Fixed 3/10 failing files.',
  '```\nconst score = 46/100;\n```',
  'v1.10/100 is the path segment',
  'Processed 50/100 queries so far',
  // Targets and thresholds that DO carry a score word — these hold the THRESHOLD guards (a mutant that
  // drops them goes red).
  'The North Star score needs to reach 95/100',
  'North Star: need 95/100 to ship',
  'Overall must be ≥95/100',
  'Ship if the overall score is >90/100',
  'North Star 95/100+ unlock ADRs are ready',
  'The pillar score target: 75/100',
];

describe('scoreAssertions — a score, grade or rating, and nothing else', () => {
  it.each(SCORES)('detects: %s', (m) => { expect(scoreAssertions(m).length).toBeGreaterThan(0); });
  it.each(NOT_SCORES)('ignores: %s', (m) => { expect(scoreAssertions(m)).toEqual([]); });
});

describe('readsAgentdb — what counts as having checked AgentDB this turn', () => {
  it.each([
    [{ name: 'Bash', input: { command: 'ruflo memory search --path /p/.swarm/memory.db -q plan' } }],
    [{ name: 'Bash', input: { command: 'cd /p && ruflo memory retrieve -k plan-4.5 -n default --path .swarm/agentdb-memory.db' } }],
    [{ name: 'Bash', input: { command: 'npx claude-flow@alpha memory list --namespace default' } }],
    [{ name: 'Bash', input: { command: 'node plugin/scripts/continuity-brief.mjs --full' } }],
    [{ name: 'mcp__claude-flow__memory_search', input: { query: 'plan' } }],
    [{ name: 'mcp__claude-flow__memory_retrieve', input: { key: 'plan' } }],
    [{ name: 'exec', input: 'ruflo memory search --path /p/.swarm/agentdb-memory.db -q score' }],
  ])('counts %j', (call) => { expect(readsAgentdb([call])).toBe(true); });
  it.each([
    [{ name: 'Bash', input: { command: 'ruflo memory store -k x --value y' } }],
    [{ name: 'Bash', input: { command: 'cat README.md' } }],
    [{ name: 'Read', input: { file_path: '/p/.swarm/memory.db' } }],
    [{ name: 'mcp__claude-flow__agentdb_hierarchical-recall', input: {} }],
    [{ name: 'mcp__claude-flow__memory_store', input: {} }],
  ])('does not count %j', (call) => { expect(readsAgentdb([call])).toBe(false); });
});

// ── transcripts ──────────────────────────────────────────────────────────────────────────────────
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const bash = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id, text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function claudeTranscript(w, lines) {
  const file = path.join(w.dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
const ANSWER = 'Scored against the North Star.\n\n**Overall: 46/100**';

describe('decide() — Claude transcripts', () => {
  const w = fakeWorld({ stores: { 'memory.db': [], 'agentdb-memory.db': [] } });
  const env = { ...w.env };
  it('blocks a score with no AgentDB read this turn, naming both stores', () => {
    const tp = claudeTranscript(w, [user('score the app against the north star'), bash('a', 'cat README.md'), result('a', 'readme'), say(ANSWER)]);
    const v = decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tp, cwd: w.proj, session_id: 's' }, env });
    expect(v.why).toBe('block');
    expect(v.text).toMatch(/score without recalling AgentDB first/);
    expect(v.text).toContain(path.join(w.swarm, 'memory.db'));
    expect(v.text).toContain(path.join(w.swarm, 'agentdb-memory.db'));
  });
  it('passes once the same turn ran ruflo memory search', () => {
    const tp = claudeTranscript(w, [user('score the app'), bash('a', `ruflo memory search --path ${w.swarm}/memory.db -q plan`), result('a', 'rows'), say(ANSWER)]);
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tp, cwd: w.proj }, env }).why).toBe('recalled');
  });
  it('a recall in an EARLIER turn does not satisfy this turn (the rule is per answer)', () => {
    const tp = claudeTranscript(w, [user('recall the plan'), bash('a', 'ruflo memory search -q plan'), result('a', 'rows'), say('ok'),
      user('now score it'), say(ANSWER)]);
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tp, cwd: w.proj }, env }).why).toBe('block');
  });
  it('an ordinary answer, a project with no store, an opt-out, or an unreadable turn never blocks', () => {
    const tp = claudeTranscript(w, [user('fix the typo'), say('Fixed the typo in README.')]);
    expect(decide({ hookInput: { last_assistant_message: 'Fixed the typo in README.', transcript_path: tp, cwd: w.proj }, env }).text).toBeNull();
    const bare = fakeWorld({ stores: {} });
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tp, cwd: bare.proj }, env }).why).toBe('no-store');
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tp, cwd: w.proj }, env: { ...env, RUVNET_AGENTDB_FIRST: 'off' } }).why).toBe('disabled');
    const tail = claudeTranscript(w, [say('…middle of a long turn'), say(ANSWER)]);   // no user boundary visible
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tail, cwd: w.proj }, env }).why).toBe('unverifiable');
  });
});

describe('decide() — Codex rollouts', () => {
  const w = fakeWorld({ stores: { 'agentdb-memory.db': [] } });
  const env = { ...w.env, RUVNET_HOOK_HOST: 'codex' };
  const started = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });
  const exec = (cmd) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: cmd } });
  const fn = (name, args) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });
  it('reads the rollout after the last task_started: blocks without a recall, passes with one', () => {
    const none = claudeTranscript(w, [started, exec('ruflo memory search -q old'), started, exec('cat README.md')]);
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: none, cwd: w.proj }, env }).why).toBe('block');
    const yes = claudeTranscript(w, [started, exec(`ruflo memory search --path ${w.swarm}/agentdb-memory.db -q plan`)]);
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: yes, cwd: w.proj }, env }).why).toBe('recalled');
    const mcp = claudeTranscript(w, [started, fn('mcp__claude_flow__memory_search', { query: 'plan' })]);
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: mcp, cwd: w.proj }, env }).why).toBe('recalled');
  });
  it('no visible turn start: the product recall receipt is the evidence, otherwise silent', () => {
    const tail = claudeTranscript(w, [exec('cat README.md')]);
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tail, cwd: w.proj, session_id: 'cx' }, env }).why).toBe('unverifiable');
    const marker = path.join(w.env.RUVNET_BRAIN_HOME, 'agentdb-first', 'cx.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ keys: [] }));
    expect(decide({ hookInput: { last_assistant_message: ANSWER, transcript_path: tail, cwd: w.proj, session_id: 'cx' }, env }).why).toBe('codex-recall-receipt');
    expect(codexTurnCalls([started, exec('x')]).boundaryFound).toBe(true);
    expect(claudeTurnCalls([say('x')]).boundaryFound).toBe(false);
  });
});

describe('the real process — once per turn, loop-safe, fail-open', () => {
  const w = fakeWorld({ stores: { 'memory.db': [] } });
  const tp = claudeTranscript(w, [user('score the app'), say(ANSWER)]);
  const run = (payload, file = GATE, args = []) => spawnSync(process.execPath, [file, ...args], { input: JSON.stringify(payload), cwd: w.proj,
    env: { ...w.env, CLAUDE_PLUGIN_ROOT: path.resolve(import.meta.dirname, '../../plugin') }, encoding: 'utf8', timeout: 20_000 });
  const base = { hook_event_name: 'Stop', session_id: 'proc-1', transcript_path: tp, last_assistant_message: ANSWER, cwd: w.proj };
  it('blocks ONCE with the Stop envelope, then stays silent for the same turn', () => {
    const first = run(base);
    expect(first.status).toBe(0);
    const env = JSON.parse(first.stdout);
    expect(env.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(env.hookSpecificOutput.additionalContext).toMatch(/ALWAYS CHECK AGENTDB FIRST/);
    expect(run(base).stdout).toBe('');
  });
  it('stop_hook_active, a missing session id, interrupted, or garbage stdin: zero bytes, exit 0', () => {
    expect(run({ ...base, session_id: 'p2', stop_hook_active: true }).stdout).toBe('');
    expect(run({ ...base, session_id: undefined }).stdout).toBe('');
    expect(run({ ...base, session_id: 'p3', interrupted: true }).stdout).toBe('');
    const g = spawnSync(process.execPath, [GATE], { input: 'not json', env: w.env, encoding: 'utf8' });
    expect(g.status).toBe(0); expect(g.stdout).toBe('');
  });
  it('dispatches through the real hook-shim id agentdb-first-gate', () => {
    const r = run({ ...base, session_id: 'via-shim' }, SHIM, ['agentdb-first-gate']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/Overall: 46\/100/);
  });
});
