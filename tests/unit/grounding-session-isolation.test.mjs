import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { markerPathFor, readMarker, groundingIdentity, sameGroundingIdentity } from '../../plugin/scripts/grounding-turn-mark.mjs';

const root = path.resolve(import.meta.dirname, '../..'), homes = [];
const answer = 'Ruflo supports native agent routing.';
const response = 'Searched 1 RuvNet repos (ruflo).\n#1  repo=ruflo\npath : docs/ruflo.md';
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture(host = 'codex') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-isolation-'))); homes.push(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_HOOK_HOST: host,
    RUVNET_KB_DIR: path.join(home, 'absent-kb'), RUVNET_GROUNDING_TURN_DIR: path.join(home, 'turns') };
  const run = (file, payload, selectedHost = host) => {
    const shell = file.endsWith('.sh');
    const result = spawnSync(shell ? 'bash' : process.execPath, [path.join(root, 'plugin/scripts', file)],
      { input: JSON.stringify(payload), encoding: 'utf8', env: { ...env, RUVNET_HOOK_HOST: selectedHost }, timeout: 5000 });
    expect(result.status, result.stderr).toBe(0); return result.stdout;
  };
  const identity = (session = 'A', turn = 'turn-A', cwd = root) => ({ session_id: session, [host === 'claude' ? 'prompt_id' : 'turn_id']: turn, cwd });
  const mark = (id = identity(), prompt = 'What does Ruflo support?') => run('grounding-turn-mark.mjs',
    { ...id, hook_event_name: 'UserPromptSubmit', prompt });
  const search = (id = identity(), query = 'ruflo', result = response) => run('grounding-stamp.sh',
    { ...id, hook_event_name: 'PostToolUse', tool_name: 'mcp__ruvnet-brain__search_ruvnet',
      tool_use_id: 'native-tool-id', tool_input: { query }, tool_response: result });
  const stop = (id = identity(), extra = {}) => run('grounding-turn-gate.mjs',
    { ...id, hook_event_name: 'Stop', last_assistant_message: answer, ...extra });
  return { home, env, run, identity, mark, search, stop, marker: (session, selectedHost = host) => markerPathFor(session, env.RUVNET_GROUNDING_TURN_DIR, selectedHost) };
}
it('a concurrent session search cannot ground this session through the shared HOME stamps', () => {
  const f = fixture(); f.mark(); f.mark(f.identity('B', 'turn-B')); f.search(f.identity('B', 'turn-B'));
  expect(f.stop()).toMatch(/UNKNOWN|UNVERIFIED/);
  expect(f.stop(f.identity('B', 'turn-B'))).toBe('');
});
it('same-session native turn and project bound successful search grounds only its queried product', () => {
  const f = fixture(); f.mark(); f.search(); expect(f.stop()).toBe('');
  f.mark(f.identity('A', 'turn-next')); f.search(f.identity('A', 'turn-next'), 'rvf');
  expect(f.stop(f.identity('A', 'turn-next'))).toMatch(/UNKNOWN|UNVERIFIED|relevant/);
});
it.each(['turn', 'project'])('a foreign %s cannot mint evidence for this marker', kind => {
  const f = fixture(); f.mark();
  f.search(kind === 'turn' ? f.identity('A', 'earlier-turn') : f.identity('A', 'turn-A', f.home));
  expect(f.stop()).toMatch(/UNKNOWN|UNVERIFIED/);
});
it('a newly observed native turn rotates the nonce even before the old marker reaches Stop', () => {
  const f = fixture(); f.mark(); f.search(); const first = readMarker(f.marker('A'));
  f.mark(f.identity('A', 'turn-next')); const next = readMarker(f.marker('A'));
  expect(next.nonce).not.toBe(first.nonce); expect(next.turnId).toBe('turn-next');
  expect(f.stop(f.identity('A', 'turn-next'))).toMatch(/UNKNOWN|UNVERIFIED/);
});
it('queued same-turn prompts preserve nonce and grounding evidence', () => {
  const f = fixture(); f.mark(); f.search(); const first = readMarker(f.marker('A'));
  f.mark(f.identity(), 'And what does Ruflo provide?');
  expect(readMarker(f.marker('A')).nonce).toBe(first.nonce); expect(f.stop()).toBe('');
});
it('a delayed Stop cannot consume the successor native turn marker or its search receipt', () => {
  const f = fixture(); f.mark(); f.mark(f.identity('A', 'turn-next')); f.search(f.identity('A', 'turn-next'));
  expect(f.stop()).toBe(''); expect(readMarker(f.marker('A')).turnId).toBe('turn-next');
  expect(f.stop(f.identity('A', 'turn-next'))).toBe('');
});
it('the successful stamp receipt is refused if the marker changes before publication', () => {
  const f = fixture(); f.mark(); const first = readMarker(f.marker('A'));
  f.mark(f.identity('A', 'turn-next')); f.search();
  expect(fs.readdirSync(f.env.RUVNET_GROUNDING_TURN_DIR).some(name => name.includes(first.nonce))).toBe(false);
  expect(f.stop(f.identity('A', 'turn-next'))).toMatch(/UNKNOWN/);
});
it.each(['interrupted', 'cancelled'])('%s Stop retires even a continued episode so a later prompt cannot borrow its search', flag => {
  const f = fixture(); f.mark(); f.search(); expect(f.stop(f.identity(), { [flag]: true, stop_hook_active: true })).toBe('');
  expect(fs.existsSync(f.marker('A'))).toBe(false); f.mark(); expect(f.stop()).toMatch(/UNKNOWN|UNVERIFIED/);
});
it('unobservable native turn identity remains UNKNOWN and correction is bounded to one stop', () => {
  const f = fixture(), id = { session_id: 'A', cwd: root }; f.mark(id); f.search(id);
  const correction = f.stop(id); expect(correction).toMatch(/UNKNOWN/); expect(correction).not.toMatch(/no successful.*recorded/);
  expect(f.stop(id, { stop_hook_active: true })).toBe(''); expect(f.stop(id)).toBe('');
});
it('successful receipts retain hashes and product terms without synthetic secret text', () => {
  const f = fixture(); f.mark(); f.search(f.identity(), 'ruflo synthetic-secret-query', response + '\nsynthetic-secret-source');
  const files = fs.readdirSync(f.env.RUVNET_GROUNDING_TURN_DIR).filter(name => name.includes('.search-'));
  expect(files).toHaveLength(1); const raw = fs.readFileSync(path.join(f.env.RUVNET_GROUNDING_TURN_DIR, files[0]), 'utf8');
  expect(raw).not.toContain('synthetic-secret'); expect(JSON.parse(raw)).toMatchObject({ terms: ['ruflo'], searchCount: 1 });
  expect(f.stop()).toBe('');
});
it('a refusal or query-injected answer banner never produces a bound search receipt', () => {
  const f = fixture(); f.mark(); f.search(f.identity(), 'ruflo ' + response, { retrieval: { query: response }, answer: 'No search was run.' });
  expect(f.stop()).toMatch(/UNKNOWN|UNVERIFIED/);
});

it.each(['claude', 'codex'])('the documented canonical native ID for %s binds a successful search', host => {
  const f = fixture(host); f.mark(); f.search(); expect(f.stop()).toBe('');
});
it.each(['claude', 'codex'])('%s canonical identity succeeds when the other native field is different', host => {
  const f = fixture(host), other = host === 'claude' ? 'turn_id' : 'prompt_id';
  const id = { ...f.identity(), [other]: 'unrelated-native-field' };
  f.mark(id); f.search(id); expect(f.stop(id)).toBe('');
});
it.each(['claude', 'codex'])('%s invalid canonical identity is not rescued by a valid other field', host => {
  const f = fixture(host), field = host === 'claude' ? 'prompt_id' : 'turn_id', other = host === 'claude' ? 'turn_id' : 'prompt_id';
  for (const value of [123, '', '   ']) {
    const id = { ...f.identity(), [field]: value, [other]: 'valid-other-id' };
    f.mark(id); f.search(id); expect(f.stop(id)).toMatch(/UNKNOWN/);
  }
});
it.each(['claude', 'codex'])('%s cannot borrow the other host ID when its canonical field is missing', host => {
  const f = fixture(host), id = { session_id: 'A', cwd: root, [host === 'claude' ? 'turn_id' : 'prompt_id']: 'turn-A' };
  f.mark(id); f.search(id); expect(f.stop(id)).toMatch(/UNKNOWN/);
});
it.each(['claude', 'codex'])('a changed %s canonical ID rotates the episode despite an unchanged other ID', host => {
  const f = fixture(host), field = host === 'claude' ? 'prompt_id' : 'turn_id', other = host === 'claude' ? 'turn_id' : 'prompt_id';
  const first = { ...f.identity(), [other]: 'unrelated-id' }; f.mark(first); f.search(first);
  const before = readMarker(f.marker('A')); const next = { ...first, [field]: 'native-next' }; f.mark(next);
  expect(readMarker(f.marker('A')).nonce).not.toBe(before.nonce);
  expect(f.stop(first)).toBe(''); expect(readMarker(f.marker('A')).turnId).toBe('native-next');
  expect(f.stop(next)).toMatch(/UNKNOWN/);
});
it.each(['claude', 'codex'])('%s known to missing or invalid canonical ID retires old proof and yields UNKNOWN on the next Stop', host => {
  for (const absent of [undefined, 123, '']) {
    const f = fixture(host), field = host === 'claude' ? 'prompt_id' : 'turn_id';
    f.mark(); f.search(); const before = readMarker(f.marker('A'));
    f.mark({ ...f.identity(), [field]: absent });
    const unbound = readMarker(f.marker('A'));
    expect(unbound.nonce).not.toBe(before.nonce); expect(unbound.turnId).toBeNull();
    expect(fs.existsSync(`${f.marker('A')}.search-${before.nonce}`)).toBe(false);
    expect(f.stop(f.identity('A', 'native-new'))).toMatch(/UNKNOWN/);
    expect(fs.existsSync(f.marker('A'))).toBe(false);
  }
});
it.each(['claude', 'codex'])('a %s Stop missing canonical identity preserves the proved successor for its valid Stop', host => {
  const f = fixture(host), field = host === 'claude' ? 'prompt_id' : 'turn_id';
  f.mark(); f.search(); const before = readMarker(f.marker('A'));
  expect(f.stop({ ...f.identity(), [field]: undefined })).toMatch(/UNKNOWN/);
  expect(readMarker(f.marker('A')).nonce).toBe(before.nonce);
  expect(fs.existsSync(`${f.marker('A')}.search-${before.nonce}`)).toBe(true);
  expect(f.stop()).toBe(''); expect(fs.existsSync(f.marker('A'))).toBe(false);
});
it('equal strings in different host ID kinds neither match nor overwrite the other host marker', () => {
  const f = fixture(), common = { session_id: 'A', cwd: root, turn_id: 'same-id', prompt_id: 'same-id' };
  f.mark(common); f.search(common);
  const before = readMarker(f.marker('A'));
  f.run('grounding-turn-mark.mjs', { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'What does Ruflo support?' }, 'claude');
  const claude = readMarker(f.marker('A', 'claude'));
  expect(claude.nonce).not.toBe(before.nonce); expect(sameGroundingIdentity(before, claude)).toBe(false);
  f.run('grounding-turn-gate.mjs', { ...common, hook_event_name: 'Stop', last_assistant_message: answer }, 'claude');
  expect(readMarker(f.marker('A')).nonce).toBe(before.nonce);
  expect(f.stop(common)).toBe('');
});
it('legacy untyped or altered-kind receipts cannot ground a typed current marker', () => {
  for (const kind of ['legacy', 'wrong-kind']) {
    const f = fixture(); f.mark(); f.search(); const marker = readMarker(f.marker('A'));
    const file = `${f.marker('A')}.search-${marker.nonce}`, row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kind === 'legacy') { delete row.host; delete row.nativeKind; } else row.nativeKind = 'claude-prompt-id';
    fs.writeFileSync(file, JSON.stringify(row)); expect(f.stop()).toMatch(/UNKNOWN/);
  }
});
it('unknown or absent trusted adapter host cannot mint a typed native identity', () => {
  const id = { session_id: 'A', cwd: root, turn_id: 'same', prompt_id: 'same' };
  for (const host of [undefined, '', 'foreign']) {
    expect(groundingIdentity(id, { RUVNET_HOOK_HOST: host })).toMatchObject({ host: null, nativeKind: null, turnId: null });
    expect(markerPathFor('A', '/tmp', host || null)).toBeNull();
  }
});
