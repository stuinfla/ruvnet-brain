// Wave 4 (L+ port), test 3, acceptance: the five layered tools served by the real installed server.
// A fixture repository is built, signed, installed into a fresh home, and asked through the server's
// own MCP stdio, exactly as a host would:
//   - tools/list holds seven tools with their schemas; the L+ answer rules (verbatim from the held-out
//     run's prompt, copied into this test independently) are in the search_ruvnet and map_ruvnet
//     descriptions and in the shipped skill;
//   - map, facts, find, context and source each answer from the pack: JSON within 20,000 characters,
//     with the expected rows, the redacted secret never shown, the hostile row flagged;
//   - bad arguments are refused at the boundary (a path out of the repository, to before from, an
//     unknown kind, no query);
//   - a damaged layered.db and a pack without one: the layered tools say so, search_ruvnet keeps working.
// Breaks (breaks-wave4.mjs): rules left out of search_ruvnet; the layered tools not listed; the path
// check removed; the layered store made a required pack file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { built, recipeFile } from './wp5-helpers.mjs';
import { FAKE_AWS, callTool, writeKit } from './wave4-helpers.mjs';

const RULES_VERBATIM =
  'Rules: (a) before saying something does not exist or is not supported, search at least three different ways (plain words, likely product name, likely file or crate name) and say what you searched; (b) for a recommended capability, open its source and state: what to call, defaults and limits, what it does not do, known pitfalls or contradictions between docs and code, and version history if the question is about a change over time; (c) cite file and line for every specific number, default or command.';
const squash = (s) => s.replace(/\s+/g, ' ');
const LAYERED = { map_ruvnet: ['query'], facts_ruvnet: ['target'], find_ruvnet: ['words'], context_ruvnet: ['repo', 'path'], source_ruvnet: ['repo', 'path'] };

/** One layered call: asserts it is a JSON answer within the cap and returns it parsed. */
async function ask(srv, name, args) {
  const r = await callTool(srv, name, args);
  assert.equal(r.isError, false, `${name} ${JSON.stringify(args)} answered with an error: ${r.text}`);
  assert.ok(r.text.length <= 20_000, `${name} answer is ${r.text.length} characters, over 20,000`);
  return JSON.parse(r.text);
}

function installPack(ctx, tree, pack) {
  const home = ctx.tmp('rb5-home-');
  const r = tree.cli(home, ['install', '--from', tree.release(pack)]);
  assert.equal(r.status, 0, `install failed: ${r.stdout}\n${r.stderr}`);
  return home;
}

test('Wave 4: the layered tools served end to end by the installed server', { timeout: 600_000 }, async (t) => {
  const ctx = setup(t, 'wave4-03');
  const tree = ctx.tree();
  const kit = writeKit(ctx);
  const home = installPack(ctx, tree, built(ctx, tree, { sources: [kit] }));
  const srv = await ctx.server(tree, home);

  // The tool list and the rules.
  const { tools } = await srv.call('tools/list', {});
  assert.deepEqual(tools.map((x) => x.name), ['search_ruvnet', 'read_ruvnet', ...Object.keys(LAYERED)], 'the server lists seven tools');
  for (const [name, required] of Object.entries(LAYERED)) {
    const def = tools.find((x) => x.name === name);
    assert.deepEqual(def.inputSchema.required, required, `${name} requires ${required}`);
    assert.equal(def.inputSchema.type, 'object');
    for (const k of required) assert.equal(def.inputSchema.properties[k].type, 'string', `${name}.${k} is text`);
  }
  for (const name of ['search_ruvnet', 'map_ruvnet']) assert.ok(tools.find((x) => x.name === name).description.includes(RULES_VERBATIM), `${name} carries the answer rules verbatim`);
  const ptr = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
  const skill = fs.readFileSync(path.join(home, 'app', ptr.app, 'plugin', 'claude', 'skills', 'ruvnet-brain', 'SKILL.md'), 'utf8');
  assert.ok(squash(skill).includes(RULES_VERBATIM), 'the installed skill carries the answer rules');
  for (const name of Object.keys(LAYERED)) assert.ok(skill.includes(name), `the skill names ${name}`);

  // map -> facts -> source: from the map to the exact lines.
  const map = await ask(srv, 'map_ruvnet', { query: 'memory store' });
  const tool = map.rows.find((r) => r.kind === 'mcp-tool' && r.name === 'memory_store');
  assert.ok(tool, `map finds the MCP tool: ${JSON.stringify(map.rows.map((r) => r.name))}`);
  assert.equal(tool.source_line, "    description: 'Persist a key and value in the episodic memory',");
  assert.equal(`${tool.source_path}:${tool.line}`, 'src/mcp/tools.ts:4');
  const facts = await ask(srv, 'facts_ruvnet', { target: String(tool.id) });
  const schema = facts.rows.find((r) => r.kind === 'mcp-schema');
  assert.equal(schema?.lines, '5-9', 'facts gives the tool schema with its lines');
  assert.match(schema.text, /required: \['key', 'value'\]/);
  const found = await ask(srv, 'find_ruvnet', { words: 'max agents' });
  assert.equal(found.rows[0]?.symbol, 'memory --max-agents', 'find ranks the all-words flag first');
  assert.equal(found.rows[0].lines, '7-7');
  const src = await ask(srv, 'source_ruvnet', { repo: 'lplus-kit', path: 'src/config.ts', from: 6, to: 8 });
  assert.deepEqual(src.lines, [[6, '};'], [7, "const fallbackKey = '[redacted]';"], [8, "const token = process.env.LPLUS_TOKEN ?? 'anonymous';"]]);
  assert.equal(src.commit, 'c0ffee1234567890abcdef');
  const ctxAns = await ask(srv, 'context_ruvnet', { repo: 'lplus-kit', path: 'src/config.ts' });
  assert.equal(ctxAns.adrs_naming_file[0]?.adr, 'docs/adr/ADR-007-memory-ttl.md', 'context names the ADR that names the file');
  assert.equal(ctxAns.capability?.name, 'lplus-kit');
  const notes = await ask(srv, 'source_ruvnet', { repo: 'lplus-kit', path: 'docs/NOTES.md' });
  assert.equal(notes.flag, 'hostile', 'a page holding a prompt-injection line is flagged');
  const repoFacts = await ask(srv, 'facts_ruvnet', { target: 'lplus-kit', kind: 'env' });
  assert.deepEqual(repoFacts.rows.map((r) => r.symbol).sort(), ['HNSW_THREADS', 'LPLUS_TOKEN']);
  for (const a of [map, facts, found, src, ctxAns, repoFacts]) assert.equal(JSON.stringify(a).includes(FAKE_AWS), false, 'no answer carries the secret');
  const unknown = await ask(srv, 'source_ruvnet', { repo: 'nope', path: 'x.md' });
  assert.match(unknown.error, /^unknown repo nope; repos: lplus-kit$/);

  // Bad arguments: refused at the boundary, as errors.
  const refused = async (name, args, re) => {
    const r = await callTool(srv, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} must be refused: ${r.text}`);
    assert.match(r.text, re);
  };
  await refused('source_ruvnet', { repo: 'lplus-kit', path: '../lplus-kit/src/config.ts' }, /is not a path inside a repository/);
  await refused('source_ruvnet', { repo: 'lplus-kit', path: '/etc/passwd' }, /is not a path inside a repository/);
  await refused('source_ruvnet', { repo: 'lplus-kit', path: 'src/config.ts', from: 9, to: 3 }, /to \(3\) is before from \(9\)/);
  await refused('facts_ruvnet', { target: 'x', kind: 'secrets' }, /kind must be one of/);
  await refused('map_ruvnet', {}, /query is required/);
  await refused('find_ruvnet', { words: 'x', cursor: -1 }, /cursor must be a whole number/);
  await srv.close();

  // A damaged layered store: the layered tools say so; search keeps working.
  const packDir = path.join(home, 'packs', ptr.pack);
  fs.truncateSync(path.join(packDir, 'layered.db'), 4096);
  const srv2 = await ctx.server(tree, home);
  const still = await srv2.search('episodic memory key value');
  assert.equal(still.isError, false, `search keeps working with a damaged layered store: ${still.text.slice(0, 300)}`);
  assert.match(still.mode, /^MODE · normal$/, 'search keeps working with a damaged layered store, not in safe mode');
  const dmg = await callTool(srv2, 'map_ruvnet', { query: 'memory' });
  assert.equal(dmg.isError, true);
  assert.match(dmg.text, /the layered store layered\.db is missing or has the wrong size/);
  await srv2.close();

  // A pack built from a recipe without a layered store.
  const recipe = recipeFile(ctx, tree, (r) => delete r.layered);
  const plain = built(ctx, tree, { sources: [kit], recipe });
  assert.equal(fs.existsSync(path.join(plain, 'layered.db')), false, 'no layered store without the recipe block');
  const srv3 = await ctx.server(tree, installPack(ctx, tree, plain));
  const none = await callTool(srv3, 'facts_ruvnet', { target: 'lplus-kit' });
  assert.equal(none.isError, true);
  assert.match(none.text, /this pack has no layered store/);
  assert.equal((await srv3.search('episodic memory')).isError, false, 'search works in a pack without a layered store');
  await srv3.close();
});
