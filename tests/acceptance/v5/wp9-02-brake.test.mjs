// WP9-02 the brake. Migration with --register-hosts puts version 5 beside 4.7 in the host files (4.7's
// entries kept; version 5's server is named ruvnet-brain-5 for the side-by-side period, so it sits
// beside 4.7's ruvnet-brain in Codex too). `ruvnet-brain rollback-to-4` then returns the host files to exactly their
// pre-migration bytes, turns version 5's automatic update off, and checks that 4.7 can serve; `--undo`
// puts version 5 back and it answers again. With 4.7 gone, the brake refuses and changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, setup } from './helpers.mjs';
import { hashTree, make47, runCli, searchV5, world47 } from './wp9-helpers.mjs';

const Q = 'how does the quillfeather index descend its layers with marrowlight';
const launcherIn = (s, file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(path.join(s.home5, 'shim'));

test('WP9-02 rollback-to-4 hands back to 4.7 in one command, and --undo reverses it', { timeout: 400_000 }, async (t) => {
  const ctx = setup(t, 'wp9-02');
  const tree = ctx.tree();
  const rel = tree.release(tree.build(THREE));
  const s = make47(ctx);
  const before = world47(s);
  const claudeBefore = hashTree(s.claude);
  const codexBefore = hashTree(path.dirname(s.codexToml));
  const stateFile = path.join(s.claude, '.claude.json');

  const r = runCli(tree, s, ['migrate', '--apply', '--from', rel, '--register-hosts']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const settings = JSON.parse(fs.readFileSync(path.join(s.claude, 'settings.json'), 'utf8'));
  assert.equal(settings.enabledPlugins['ruvnet-brain@ruvnet-brain'], true, "4.7's plug-in entry is kept");
  assert.equal(settings.hooks.UserPromptSubmit.length, 2, "4.7's hook and version 5's hook sit side by side");
  assert.ok(launcherIn(s, stateFile), 'version 5 search server is registered with Claude Code');
  assert.equal(fs.readFileSync(s.codexToml, 'utf8').includes('[mcp_servers.ruvnet-brain]'), true, "4.7's Codex server is kept");
  assert.match(fs.readFileSync(s.codexToml, 'utf8'), /\[mcp_servers\.ruvnet-brain-5\]\ncommand = "[^"]+"/, 'version 5 serves Codex beside 4.7 under its own name');
  assert.match(r.stdout, /every registered host is served by version 5 \(server ruvnet-brain-5\), beside 4\.7/);
  assert.ok(launcherIn(s, s.codexToml) && launcherIn(s, path.join(path.dirname(s.codexToml), 'hooks.json')), 'version 5 is registered in Codex (server and hook)');

  // The brake.
  const b = runCli(tree, s, ['rollback-to-4']);
  assert.equal(b.status, 0, `${b.stdout}\n${b.stderr}`);
  assert.match(b.stdout, /brake on: version 5 is switched off .*4\.7 \(version 4\.7\.28/);
  assert.deepEqual(hashTree(s.claude), claudeBefore, 'every Claude Code file is back to its pre-migration bytes');
  assert.deepEqual(hashTree(path.dirname(s.codexToml)), codexBefore, 'every Codex file is back to its pre-migration bytes');
  assert.equal(JSON.parse(runCli(tree, s, ['config', 'show']).stdout).autoUpdate, false, 'version 5 stops updating itself');
  assert.deepEqual(world47(s), before, '4.7 itself is never touched');
  const twice = runCli(tree, s, ['rollback-to-4']);
  assert.equal(twice.status, 0, 'pulling the brake again is harmless');
  const blocked = runCli(tree, s, ['migrate', '--apply', '--from', rel]);
  assert.equal(blocked.status, 1, 'migration refuses while the brake is on');
  assert.match(blocked.stderr, /the brake is on/);

  // Release the brake: version 5 is registered and answers again.
  const u = runCli(tree, s, ['rollback-to-4', '--undo']);
  assert.equal(u.status, 0, `${u.stdout}\n${u.stderr}`);
  assert.ok(launcherIn(s, stateFile), 'version 5 is registered again');
  assert.equal(JSON.parse(runCli(tree, s, ['config', 'show']).stdout).autoUpdate, false, 'the carried "no" to automatic updates is what comes back');
  const res = await searchV5(ctx, tree, s.home5, Q);
  assert.equal(res.files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', 'version 5 answers after --undo');

  // No 4.7 to go back to: the brake refuses and version 5 stays on.
  const g = make47(ctx);
  assert.equal(runCli(tree, g, ['migrate', '--apply', '--from', rel, '--register-hosts']).status, 0);
  fs.rmSync(path.join(g.kb, 'alpha-vectors.big.rvf'));
  fs.rmSync(path.join(g.kb, 'alpha-vectors.passages.jsonl'));
  fs.rmSync(path.join(g.kb, 'alpha-vectors.meta.json'));
  const gone = runCli(tree, g, ['rollback-to-4']);
  assert.equal(gone.status, 1, 'the brake must refuse when 4.7 cannot serve');
  assert.match(gone.stderr, /4\.7 cannot serve .*holds no public knowledge store/);
  assert.ok(launcherIn(g, path.join(g.claude, '.claude.json')), 'version 5 stays registered when the brake refuses');
});
