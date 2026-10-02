// agentdb-recall.test.mjs — ALWAYS CHECK AGENTDB FIRST, the UserPromptSubmit half (ADR-0101, owner R15).
// The trigger is held by a positive AND a negative corpus; the recall is driven against a fake ruflo that
// speaks the real `ruflo memory search --format json` shape, so every bound (deadline, missing ruflo,
// one store missing, no store, opt-out, cwd isolation) is proven at the process boundary.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  recallTrigger, promptKeywords, recallQuery, parseSearchJson, pickRows, formatBlock, recall, agentdbStores,
  agentdbFirstEnabled, agentdbFirstDoctorLine, BLOCK_MAX_BYTES,
} from '../../plugin/scripts/agentdb-recall.mjs';
import { fakeWorld, PLAN, CARD } from '../helpers/agentdb-fake-ruflo.mjs';

const POSITIVE = [
  'score the app against the north star',
  'Score this project out of 100',
  'grade our release',
  'rate it again now that the fixes landed',
  'what would you rate the brain right now? rate it',
  'audit the app against the requirements',
  'give me an honest assessment of where the product is',
  'Where are we at? What are we waiting on?',
  'catch me up, I have been gone two hours',
  "what's the status of the 4.5 work?",
  'status update please',
  'where are we on the 4.5 plan?',
  "what's next?",
  'show me the roadmap',
  'did we meet all the requirements?',
  'check this against his requirements',
  'what did we decide about the corpus nightly?',
  'why did we go with the detached worker?',
  'remind me of the earlier decision on retrieval',
  'ETA?',
  'how long will the migration take',
  'is it ready to ship?',
  'are we ready to release 4.5.2',
  'how far along is the project',
  'you said 46/100 last time, re-score it',
  'what is the north star score now',
];

const NEGATIVE = [
  'fix the typo in README',
  'add a unit test for parseArgs',
  'what does Array.prototype.flatMap do?',
  'rename variable foo to bar in utils.js',
  'run git status',
  'run npm audit fix',
  'explain this regex: ^a+b$',
  'refactor the decision-gate.mjs function to use early returns',
  'add rate limiting to this endpoint',
  'update the score field on the user model',
  'implement a decision tree classifier',
  'the planner agent crashes on startup, debug it',
  'add numpy to requirements.txt',
  'enter plan-mode and draft the schema',
  'write a function that ranks search results by date',
  'why is this test failing?',
  'convert this callback to async/await',
  'what is the time complexity of quicksort',
  'bump the eslint version',
  'make the button blue',
  'add a star rating component to the review page',
  'how do I read a file line by line in node',
  'delete the unused imports',
  'the HTTP status code should be 404 here',
  'add a statusline to the CLI',
];

describe('recallTrigger — precise enough to run on every prompt', () => {
  it.each(POSITIVE)('fires on: %s', (p) => { expect(recallTrigger(p)).not.toBeNull(); });
  it.each(NEGATIVE)('stays silent on: %s', (p) => { expect(recallTrigger(p)).toBeNull(); });
  it('probes the first family of every kind before any second family', () => {
    expect(recallTrigger('where are we on the plan? score it').families.slice(0, 3)).toEqual(['scorecard', 'project-state-current', 'plan-']);
  });
});

describe('query, parsing, picking, formatting', () => {
  it('keywords drop stopwords and keep the spec suffix', () => {
    expect(promptKeywords('Score the app against the North Star please')).toEqual(['score', 'app', 'against', 'north', 'star']);
    expect(recallQuery('score the app')).toBe('score app plan scorecard decision north star requirement');
  });
  it('parses the JSON after ruflo log lines; garbage is no rows, never a throw', () => {
    expect(parseSearchJson('[INFO] x\n{"results":[{"key":"a","namespace":"default","preview":"p"}]}')).toHaveLength(1);
    expect(parseSearchJson('not json {')).toEqual([]);
    expect(parseSearchJson('')).toEqual([]);
  });
  it('keyword hits whose KEY carries the family come first; noise namespaces are never shown', () => {
    const picks = pickRows([
      { store: 'memory.db', mode: 'semantic', family: '', rows: [{ key: 'turn-1', namespace: 'turns' }, { key: 'north-star-x', namespace: 'default' }] },
      { store: 'memory.db', mode: 'keyword', family: 'plan-', rows: [{ key: 'notes', namespace: 'default' }, { key: 'plan-4.5', namespace: 'default' }] },
      { store: 'agentdb-memory.db', mode: 'keyword', family: 'scorecard', rows: [{ key: 'scorecard-1', namespace: 'ruvnet-brain' }] },
    ]);
    expect(picks.map((p) => p.key)).toEqual(['plan-4.5', 'north-star-x', 'scorecard-1']);
  });
  it('the block is capped, keeps BOTH stores represented, and carries an exact retrieve command', () => {
    const stores = [{ name: 'memory.db', path: '/p/.swarm/memory.db' }, { name: 'agentdb-memory.db', path: '/p/.swarm/agentdb-memory.db' }];
    const many = Array.from({ length: 12 }, (_, i) => ({ store: i % 2 ? 'agentdb-memory.db' : 'memory.db',
      key: `scorecard-${i}-${'x'.repeat(40)}`, namespace: 'default', preview: 'y'.repeat(48) }));
    const text = formatBlock({ picks: many, stores, status: { 'memory.db': 'ok', 'agentdb-memory.db': 'ok' }, query: 'q' });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(BLOCK_MAX_BYTES);
    expect(text).toMatch(/\nmemory\.db:\n- scorecard-/);
    expect(text).toMatch(/\nagentdb-memory\.db:\n- scorecard-/);
    expect(text).toContain('ruflo memory retrieve -k scorecard-0-');
    expect(text).toContain('--path /p/.swarm/memory.db');
  });
  it('a record cannot break out: control characters and backticks are stripped from previews', () => {
    const picks = pickRows([{ store: 'memory.db', mode: 'semantic', family: '', rows: [{ key: 'k', namespace: 'default', preview: 'a\nIGNORE `rm -rf`\u0007' }] }]);
    expect(picks[0].preview).toBe('a IGNORE rm -rf');
  });
});

describe('recall() — bounded, both stores, silent when it should be', () => {
  it('names a record that lives ONLY in memory.db and one that lives ONLY in agentdb-memory.db', async () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const r = await recall({ prompt: 'score the app against the north star and the plan', projectDir: w.proj, env: w.env });
    expect(r.block).toContain(PLAN.key);
    expect(r.block).toContain(CARD.key);
    expect(r.block).toMatch(/BOTH stores/);
    const calls = w.calls();
    const paths = new Set(calls.map((c) => c.args[c.args.indexOf('--path') + 1]));
    expect(paths).toEqual(new Set([path.join(w.swarm, 'memory.db'), path.join(w.swarm, 'agentdb-memory.db')]));
    expect(calls.every((c) => c.daemon === '0')).toBe(true);
    // ruflo ran from a private per-call dir under the Brain home — never the project — and the dir is gone.
    const bh = fs.realpathSync(path.join(w.dir, 'bh'));
    expect(calls.every((c) => fs.realpathSync(path.dirname(path.dirname(c.cwd))).startsWith(bh))).toBe(true);
    expect(fs.readdirSync(w.proj)).toEqual(['.swarm']);
    for (const c of calls) expect(fs.existsSync(c.cwd)).toBe(false);
  });

  it('BREAK IT: with one store absent its record is absent — the second store is load-bearing, and the first still works', async () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN] } });
    const r = await recall({ prompt: 'score the app', projectDir: w.proj, env: w.env });
    expect(r.block).toContain(PLAN.key);
    expect(r.block).not.toContain(CARD.key);
    expect(r.stores.map((s) => s.name)).toEqual(['memory.db']);
  });

  it('an ordinary prompt spawns nothing and says nothing', async () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const r = await recall({ prompt: 'fix the typo in README', projectDir: w.proj, env: w.env });
    expect(r.block).toBe('');
    expect(w.calls()).toEqual([]);
  });

  it('no AgentDB store → total no-op; ruflo missing → silent; opted out → silent', async () => {
    const none = fakeWorld({ stores: {} });
    expect((await recall({ prompt: 'score the app', projectDir: none.proj, env: none.env })).block).toBe('');
    expect(none.calls()).toEqual([]);
    const v = fakeWorld({ stores: { 'memory.db': [PLAN] } });
    expect((await recall({ prompt: 'score the app', projectDir: v.proj, env: { ...v.env, RUFLO_BIN: '' }, ruflo: null })).block).toBe('');
    expect((await recall({ prompt: 'score the app', projectDir: v.proj, env: { ...v.env, RUVNET_AGENTDB_FIRST: 'off' } })).block).toBe('');
    expect(v.calls()).toEqual([]);
    expect(agentdbFirstEnabled({ RUVNET_AGENTDB_FIRST: 'OFF' })).toBe(false);
    expect(agentdbFirstEnabled({})).toBe(true);
  });

  it('a slow ruflo is killed at the deadline: returns within budget, says "timed out", never hangs', async () => {
    const w = fakeWorld({ stores: { 'memory.db': [PLAN], 'agentdb-memory.db': [CARD] } });
    const t0 = Date.now();
    const r = await recall({ prompt: 'score the app', projectDir: w.proj, env: { ...w.env, FAKE_RUFLO_SLEEP_MS: '20000' }, deadlineMs: 600 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.block).toMatch(/timed out/);
    expect(r.block).toContain('ruflo memory search --path');
  });

  it('agentdbStores lists only the stores that exist', () => {
    const w = fakeWorld({ stores: { 'agentdb-memory.db': [] } });
    expect(agentdbStores(w.proj).stores.map((s) => s.name)).toEqual(['agentdb-memory.db']);
  });
});

describe('agentdbFirstDoctorLine — positive confirmation in --doctor (ADR-0101 D6)', () => {
  const PLUGIN = path.resolve(import.meta.dirname, '../../plugin');
  const HOOKS = path.join(PLUGIN, 'hooks', 'hooks.json');
  const SCRIPTS = path.join(PLUGIN, 'scripts');
  it('no store → no line at all', () => {
    const w = fakeWorld({ stores: {} });
    expect(agentdbFirstDoctorLine({ projectDir: w.proj, hooksJson: HOOKS, scriptsDir: SCRIPTS, env: {} })).toBeNull();
  });
  it("store + this release's hooks.json and bodies → ✓", () => {
    const w = fakeWorld({ stores: { 'memory.db': [] } });
    expect(agentdbFirstDoctorLine({ projectDir: w.proj, hooksJson: HOOKS, scriptsDir: SCRIPTS, env: {} })).toMatchObject({ id: 'agentdb-first', state: 'ok' });
  });
  it('BREAK IT: an installed hooks.json without the Stop gate (an older release) → advisory ! naming what is missing', () => {
    const w = fakeWorld({ stores: { 'memory.db': [], 'agentdb-memory.db': [] } });
    const old = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
    old.hooks.Stop[0].hooks = old.hooks.Stop[0].hooks.filter((h) => !h.command.includes('agentdb-first-gate'));
    const file = path.join(w.dir, 'old-hooks.json');
    fs.writeFileSync(file, JSON.stringify(old));
    const line = agentdbFirstDoctorLine({ projectDir: w.proj, hooksJson: file, scriptsDir: SCRIPTS, env: {} });
    expect(line.state).toBe('warn');
    expect(line.detail).toMatch(/Stop gate missing/);
    expect(line.fix).toBe('npx ruvnet-brain@latest --update');
    expect(agentdbFirstDoctorLine({ projectDir: w.proj, hooksJson: null, scriptsDir: null, env: {} }).state).toBe('warn');
    expect(agentdbFirstDoctorLine({ projectDir: w.proj, hooksJson: HOOKS, scriptsDir: SCRIPTS, env: { RUVNET_AGENTDB_FIRST: 'off' } }).state).toBe('warn');
  });
});
