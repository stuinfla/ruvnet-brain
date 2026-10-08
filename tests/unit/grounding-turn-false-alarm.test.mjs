// tests/unit/grounding-turn-false-alarm.test.mjs
//
// THE FALSE ALARM (measured 2026-09-30 in this repository's live Claude Code sessions). The Stop gate
// said "no successful search_ruvnet call is in this turn's transcript" on turns that asserted NOTHING
// about a rUv tool: release status, git/CI checks, disk and backup answers, memory writes. Gate 1 arms
// on any prompt naming the rUv stack, and in this repo nearly every prompt does (`ruvnet-brain`,
// "rUv", "swarm"). Of the 183 real deliveries recorded in the session transcripts, 172 were on turns
// with no rUv capability claim at all.
//
// The rule now: Gate 1 demands a search only when the FINAL ANSWER asserts what a rUv product does
// (grounding-turn-evidence.mjs ruvCapabilityClaims). Pinned through the REAL decide(), plus the
// subprocess path, on tests/fixtures/grounding-turn-stop-points.json: the deciding excerpt of each real
// Stop point (labelled by hand before the detector existed; `synthetic` where it had to be reworded to
// be public-safe), with only whether a search answered that turn. The full labelled set is measured
// outside the repository and never committed.
//
// Known misses are pinned, not hidden: each `knownMiss` fixture is a real capability claim this
// deterministic detector does not see (table-cell-only, pronoun subject, copula, parenthetical, product
// named after the verb). If one starts firing, this goes red so it can be promoted to expectFire.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groundingIdentity } from '../../plugin/scripts/grounding-turn-mark.mjs';
import { decide } from '../../plugin/scripts/grounding-turn-gate.mjs';
import { ruvCapabilityClaims } from '../../plugin/scripts/grounding-turn-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { fixtures } = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'grounding-turn-stop-points.json'), 'utf8'));
const FALSE_ALARM = /no successful(?:\s|\\n)+search_ruvnet call/;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfa-'));
const ENV = { ...process.env, HOME, RUVNET_HOOK_HOST: 'claude', RUVNET_ASSERTION_SHADOW_LOG: path.join(HOME, 'shadow.jsonl'), RUVNET_KB_DIR: path.join(HOME, 'no-kb') };

function transcriptOf(f) {
  const rows = [{ type: 'user', message: { role: 'user', content: '(prompt omitted from fixture)' } }];
  // The turn's one relevant fact: did a search_ruvnet call answer. A status turn's shell/git calls never
  // ground a rUv claim, so a single neutral shell call stands in for them.
  const [name, input, result] = f.searchedOk
    ? ['mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet', { query: 'ruflo' }, 'Searched 1 RuvNet repos (fixture).']
    : ['Bash', { command: 'git status' }, 'clean'];
  rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name, input }] } });
  rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: result }] } });
  rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: f.message }] } });
  // Corpus messages retain their original labels; this wrapper is explicitly constructed.
  for (const row of rows) Object.assign(row, { sessionId: 's', promptId: 'constructed-corpus-turn', cwd: HOME });
  rows[0].uuid = 'constructed-corpus-user-record';
  return rows.map((r) => JSON.stringify(r));
}
const gate1 = { gate1: true, assert: false, architecture: false, subjects: [] };
const fires = (f) => {
  const transcript = path.join(HOME, 'constructed-corpus.jsonl');
  fs.writeFileSync(transcript, transcriptOf(f).join('\n') + '\n');
  const input = { hook_event_name: 'Stop', session_id: 's', prompt_id: 'constructed-corpus-turn', cwd: HOME, transcript_path: transcript, last_assistant_message: f.message };
  return FALSE_ALARM.test(decide({ hookInput: input, marker: { ...gate1, ...groundingIdentity(input, ENV),
    nonce: '00000000-0000-4000-8000-000000000001' }, markerMs: Date.now(), env: ENV }) || '');
};

describe('Gate 1 on real Stop points: demand a search only for a rUv capability assertion', () => {
  it('the fixture is what it claims to be (labelled real Stop points, every category present)', () => {
    const cats = new Set(fixtures.map((f) => f.category));
    for (const c of ['asserts-ruv-capability', 'release-status', 'git-ci', 'disk-backup', 'memory-write']) expect(cats, c).toContain(c);
    expect(fixtures.filter((f) => f.expectFire).length).toBeGreaterThanOrEqual(7);
    expect(fixtures.filter((f) => f.label === 'no-ruv-capability-claim').length).toBeGreaterThanOrEqual(25);
  });

  it('the fixture is PUBLIC-SAFE: no paths, usernames, secrets, keys, tokens or credential-shaped strings', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'grounding-turn-stop-points.json'), 'utf8');
    // The owner's username is assembled, so this guard does not itself put the name into the repository.
    const banned = [/\/Users\//, /\/home\//, new RegExp(['stuart', 'kerr'].join(''), 'i'), /secret/i, /key\.pem/i, /API_KEY/, /token/i, /credential/i, /password/i,
      /\b(?:ghp|gho|ghs|github_pat|npm|xox[bpa]|AKIA|sk|pk)[-_][A-Za-z0-9]{6,}/, /BEGIN [A-Z ]*PRIVATE/, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
      /~\//, /\.(?:mjs|js|sh|json|yml|md|db|pem)\b/];
    for (const re of banned) expect(raw, `fixture matches ${re}`).not.toMatch(re);
    for (const f of fixtures) expect(f.message.length, f.id).toBeLessThanOrEqual(400);
  });

  it('ZERO false alarms on status / git-CI / disk-backup / memory-write turns, ZERO misses on the claims it is meant to catch', () => {
    const falsePositives = fixtures.filter((f) => !f.expectFire && !f.knownMiss && fires(f)).map((f) => f.id);
    const falseNegatives = fixtures.filter((f) => f.expectFire && !fires(f)).map((f) => f.id);
    expect(falsePositives, 'fired on a turn that asserts no unsearched rUv capability').toEqual([]);
    expect(falseNegatives, 'silent on an unsearched rUv capability claim').toEqual([]);
  });

  it('known misses stay pinned (red the day one is caught: promote it to expectFire)', () => {
    const miss = fixtures.filter((f) => f.knownMiss);
    expect(miss.length).toBe(2);
    for (const f of miss) expect(fires(f), `${f.id}: ${f.knownMiss}`).toBe(false);
  });

  it('a capability claim made AFTER a successful search is grounded (silent)', () => {
    const grounded = fixtures.filter((f) => f.label === 'asserts-ruv-capability' && f.searchedOk);
    expect(grounded.length).toBeGreaterThan(0);
    for (const f of grounded) expect(fires(f), f.id).toBe(false);
  });
});

describe('ruvCapabilityClaims: each rule, with the claim it must still catch', () => {
  const claims = (s) => ruvCapabilityClaims(s).map((c) => c.subject);
  it('catches plain capability assertions about a rUv product', () => {
    expect(claims('MetaHarness routes cheap-vs-frontier models for cost.')).toEqual(['metaharness']);
    expect(claims('Ruflo\'s direct executor needs an API key.')).toEqual(['ruflo']);
    expect(claims('AgentDB does not support cross-project queries.')).toEqual(['agentdb']);
    expect(claims('`ruflo memory store --path X` still writes `.swarm/hnsw.index` into the cwd.')).toEqual(['ruflo']);
    expect(claims('rUv\'s own v3.32.34 release notes say no manual SQL is needed.')).toEqual(['ruv']);
    expect(claims('rUv\'s tools turn a week of reading into minutes.')).toEqual(['ruv']);
    // 4.4.1: a product row asserts what the product does (this was pinned [] as a known limitation).
    expect(claims('| RuVector | supports HNSW |')).toEqual(['ruvector']);
  });
  it('a CLI noun phrase is not subject + verb', () => {
    expect(claims('ruflo memory store stays the only writer.')).toEqual([]);
    expect(claims('Stores via ruflo memory store --path .swarm/memory.db.')).toEqual([]);
    expect(claims('ruflo hooks intelligence --status spawn was the same class of bug.')).toEqual([]);
  });
  it('a measurement is not a capability claim', () => {
    expect(claims('ruflo memory search returns 10 results.')).toEqual([]);
    expect(claims('Each ruflo call takes about 3 seconds.')).toEqual([]);
    expect(claims('ruflo memory search returns stored rows ranked by similarity.')).toEqual(['ruflo']);
  });
  it('hedges, plans, questions, noun clauses and change reports are not assertions', () => {
    expect(claims('AgentDB might support that.')).toEqual([]);
    expect(claims('Does ruflo support that?')).toEqual([]);
    expect(claims('I will check whether ruflo supports it.')).toEqual([]);
    expect(claims('Nothing duplicates what rUv already ships.')).toEqual([]);
    expect(claims('AgentDB now records every turn automatically, with no reliance on me remembering.')).toEqual([]);
    expect(claims('Ruv can\'t use Brain if every update breaks his swarms.')).toEqual([]);
  });
  it('4.4.0 review S2: recency, later-clause conditions, will-not and same-sentence pronouns ARE claims', () => {
    expect(claims('Ruflo now supports Windows natively.')).toEqual(['ruflo']);
    expect(claims('RuVector cannot run on Windows, so if you need it use WSL.')).toEqual(['ruvector']);
    expect(claims('Ruflo is the orchestration layer and it has no hooks API.')).toEqual(['ruflo']);
    expect(claims('AgentDB will not open a store written by a newer release.')).toEqual(['agentdb']);
    expect(claims('The builds (ruvector, rvf) are native, so they don\'t depend on Node.')).toEqual([]);
  });
  it('4.4.1 LIVE MISS: definitions, "<Product>\'s <noun>", parentheticals after the subject and chained "it defaults to" ARE claims', () => {
    // Verbatim from a live `claude -p` turn on the installed 4.4.0 (ungrounded, and partly wrong).
    expect(claims('The RuVector router package (`ruvector-router`) is a vector database with a neural routing and inference layer that uses HNSW indexing to send queries or requests to the best-matching target, and it defaults to cosine distance.')).toEqual(['ruvector']);
    expect(claims('RuVector\'s router defaults to cosine distance.')).toEqual(['ruvector']);
    expect(claims('The RuVector router package (ruvector-router) uses HNSW indexing, and it defaults to cosine distance.')).toEqual(['ruvector']);
    expect(claims('The RuVector router package is a semantic intent router.')).toEqual(['ruvector']);
    // …and the guards: a status that merely uses "is a", a definition not opening the sentence.
    expect(claims('One small thing: your ruflo is a version behind.')).toEqual([]);
    expect(claims('The fix for ruflo is a one-line change in this repo.')).toEqual([]);
  });
  it('4.4.1 review: status phrasing in rows, our CHANGES to a product, "own CI", and a fix heading are not claims', () => {
    for (const s of ['| ruflo | Upgraded and restarted |', '| ruflo | Installed globally |', '| agentdb | Healthy and reachable |',
      'The ruflo upgrade is a no-op.', 'The AgentDB write is a success.', 'This is ruflo\'s own CI failing.',
      '## What the ruflo fix does\n\nIt\'s a one-line change in the hook.',
      // Each of these is rejected by ONE rule only, so each rule is proven on its own:
      'The ruflo upgrade is a three-step process.',                  // a change-noun is not the product
      'Ruflo is a no-op for this repo.',                             // an outcome noun is not a definition
      '## What the ruflo fix does\n\nIt\'s a small wrapper around the CLI.',   // the heading must name the product itself
    ]) expect(claims(s), s).toEqual([]);
  });
  it('4.4.1 KNOWN-MISS LIFTS: heading-bound pronoun, product rows, "this is X\'s own …", passive agent', () => {
    expect(claims('## What AgentDB actually is\n\nIt\'s a SQLite database file that stores notes across sessions.')).toEqual(['agentdb']);
    expect(claims('## Release status\n\nIt\'s a clean tree and it is green.')).toEqual([]);
    expect(claims('| **AgentDB** | Append-only audit trail | Concurrent-write safe KB |')).toEqual(['agentdb']);
    expect(claims('| ruflo | 3.41.2 | PASS |\n| ruflo | No version at all | stale |')).toEqual([]);
    // Letters-only, multi-word cells that are STATUS, not description: only the status vocabulary rejects these.
    expect(claims('| Ruflo | Not verified yet | Still pending review |')).toEqual([]);
    expect(claims('Note this is agentic-qe\'s own static/heuristic estimate, not instrumented coverage.')).toEqual(['agentic-qe']);
    expect(claims('The daemon-autostart setting is confirmed honored by the installed ruflo.')).toEqual(['ruflo']);
    expect(claims('The checkpoint is saved by ruflo memory store.')).toEqual([]);
  });
  it('4.4.0 re-review nit: OUR changes phrased with "will not" / "now" / a pronoun are not product claims', () => {
    expect(claims('Ruflo will not be touched by this patch.')).toEqual([]);
    expect(claims('RuVector will not need a rebuild after this change.')).toEqual([]);
    expect(claims('AgentDB now records every turn automatically.')).toEqual([]);
    expect(claims('Ruflo is installed globally and it runs from ~/.npm-global/bin.')).toEqual([]);
  });
  it('this product and paths are not rUv products', () => {
    expect(claims('RuvNet Brain supports private overlays.')).toEqual([]);
    expect(claims('ruvnet-brain supports private overlays.')).toEqual([]);
    expect(claims('kb/ruvector.big.rvf supports nothing; plugin/scripts/ruflo-x.mjs writes logs.')).toEqual([]);
    expect(claims('RuvNet tools supports nothing here.')).toEqual(['ruvnet']);
  });
  it('quoted material and fenced output are someone else\'s words', () => {
    expect(claims('The doc says "ruflo supports X." and nothing else.')).toEqual([]);
    expect(claims('```\nruflo supports everything\n```')).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('the real Stop process', () => {
  const GATE = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-gate.mjs');
  const MARK = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-mark.mjs');
  function world() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfa-e2e-'));
    const dir = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(dir, { recursive: true });
    return { home, transcript: path.join(dir, 's.jsonl'), env: { ...ENV, HOME: home, RUVNET_HOOK_HOST: 'claude', RUVNET_GROUNDING_TURN_DIR: path.join(home, 'gt') } };
  }
  const node = (file, w, payload) => spawnSync(process.execPath, [file], { input: JSON.stringify(payload), env: w.env, encoding: 'utf8', timeout: 15_000 });
  function stop(w, message, rows) {
    const identity = { session_id: 'e1', prompt_id: 'constructed-e1', cwd: w.home };
    node(MARK, w, { hook_event_name: 'UserPromptSubmit', ...identity, prompt: 'ship ruvnet-brain 4.4.0 and check CI' });
    for (const row of rows) Object.assign(row, { sessionId: identity.session_id, promptId: identity.prompt_id, cwd: identity.cwd });
    rows[0].uuid = 'constructed-e1-user-record';
    fs.writeFileSync(w.transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return node(GATE, w, { hook_event_name: 'Stop', ...identity, transcript_path: w.transcript, last_assistant_message: message, stop_hook_active: false });
  }
  const bashTurn = (message) => [
    { type: 'user', message: { role: 'user', content: 'ship ruvnet-brain 4.4.0 and check CI' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'gh run list --limit 3' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'completed success preflight' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: message }] } },
  ];
  it('a rUv-named repo, git/gh only, status answer: SILENT', () => {
    const w = world();
    const r = stop(w, 'Preflight is green on 94bd932f and the release run is install-verified on all three OSes.', bashTurn('x'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
  it('same turn, but the answer asserts a rUv capability from memory: FIRES and names the claim', () => {
    const w = world();
    const msg = 'Preflight is green. Ruflo supports cross-project memory queries out of the box.';
    const r = stop(w, msg, bashTurn(msg));
    expect(r.stdout).toMatch(FALSE_ALARM);
    expect(JSON.parse(r.stdout).reason).toContain('Ruflo supports cross-project memory queries');
  });
  it('LONG turn (tail cannot see the prompt): remains UNKNOWN with no bound receipt, even with fresh global stamps', () => {
    const msg = 'Ruflo supports cross-project memory queries out of the box.';
    const longRows = (m) => {
      const rows = [{ type: 'user', message: { role: 'user', content: 'what does ruflo do?' } }];
      for (let i = 0; i < 30; i++) {
        rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'cat big' } }] } });
        rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, content: 'x'.repeat(100_000) }] } });
      }
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: m }] } });
      return rows;
    };
    const none = world();
    const r1 = stop(none, msg, longRows(msg));
    expect(fs.statSync(none.transcript).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(r1.stdout, 'a long turn with unobservable search history must not pass silently').toMatch(/UNKNOWN/);
    expect(r1.stdout).not.toMatch(FALSE_ALARM);

    const stamped = world();
    node(MARK, stamped.env && stamped, { hook_event_name: 'UserPromptSubmit', session_id: 'e1', prompt: 'what does ruflo do?' });
    const g = path.join(stamped.home, '.cache', 'ruvnet-brain', 'grounded');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, '.any-search'), '');
    fs.writeFileSync(stamped.transcript, longRows(msg).map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r2 = node(GATE, stamped, { hook_event_name: 'Stop', session_id: 'e1', transcript_path: stamped.transcript, last_assistant_message: msg, stop_hook_active: false });
    expect(r2.stdout).toMatch(/UNKNOWN/);
  });
});
