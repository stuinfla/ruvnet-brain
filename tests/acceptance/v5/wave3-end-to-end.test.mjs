// Wave 3 end to end, on temporary homes only (a synthetic 4.7 installation built by the migration
// tests' helper): migrate --plan changes nothing, migrate --apply puts version 5 beside 4.7 and it
// serves a search through the server entry it registered; every 4.7 file is byte-identical throughout
// (the whole synthetic home is hashed); the brake (rollback-to-4) returns every host file to its
// pre-migration bytes and --undo registers version 5 again; the write guard is off by default and,
// turned on with the server stopped, allows the write with one line; the retrieval gate passes the
// synthetic question set and fails when one fixture repository is left out of the pack; the generated
// documents are current.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo, THREE, setup } from './helpers.mjs';
import { serveRegistered } from './wave2-helpers.mjs';
import { hashTree, make47, runCli, world47 } from './wp9-helpers.mjs';
import { gate, outFile, pin, questionSet, readJson, releaseOf, setHash } from './wp8-helpers.mjs';
import { TERM_TEXT, emptyTranscript, writeMsg } from './wp10-helpers.mjs';
import { runHost } from './wp7-helpers.mjs';
import { docsTree, gen } from './wp11-helpers.mjs';

const Q = 'how does the quillfeather index descend its layers with marrowlight';
const V5 = '.cache/ruvnet-brain-5/';
/** Every file of the synthetic user folder except the version 5 home: 4.7, its jobs and the host files. */
const userFiles = (s) => Object.fromEntries(Object.entries(hashTree(s.user)).filter(([k]) => !k.startsWith(V5)));
const names = (s, f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(path.join(s.home5, 'shim'));

test('Wave 3 end to end: migrate, serve, brake, undo, guard, gate, documents', { timeout: 590_000 }, async (t) => {
  const ctx = setup(t, 'wave3-end-to-end');
  const tree = docsTree(ctx);
  const rel = tree.release(tree.build(THREE));
  const s = make47(ctx);
  const files = { settings: path.join(s.claude, 'settings.json'), state: path.join(s.claude, '.claude.json'), toml: s.codexToml, codexHooks: path.join(path.dirname(s.codexToml), 'hooks.json') };
  const before = userFiles(s);
  const before47 = world47(s);

  // migrate --plan: prints the plan, changes nothing.
  const plan = runCli(tree, s, ['migrate', '--plan', '--from', rel, '--register-hosts']);
  assert.equal(plan.status, 0, `${plan.stdout}${plan.stderr}`);
  assert.match(plan.stdout, /4\.7 files changed: none/);
  assert.deepEqual(userFiles(s), before, 'migrate --plan changes nothing');
  assert.equal(fs.existsSync(s.home5), false, 'migrate --plan creates no version 5 home');

  // migrate --apply: version 5 beside 4.7, registered in both hosts, 4.7 byte-identical.
  const ap = runCli(tree, s, ['migrate', '--apply', '--from', rel, '--register-hosts']);
  assert.equal(ap.status, 0, `${ap.stdout}${ap.stderr}`);
  assert.deepEqual(world47(s), before47, 'every 4.7 file is byte-identical after migrate --apply');
  for (const f of Object.values(files)) assert.ok(names(s, f), `version 5 is registered in ${path.basename(f)}`);

  // Version 5 serves a search through the server entry it registered, started as the host starts it.
  const server = JSON.parse(fs.readFileSync(files.state, 'utf8')).mcpServers['ruvnet-brain-5'];
  const sv = await serveRegistered(t, server, { cwd: ctx.tmp('rb5-w3-proj-'), env: s.env });
  const res = await sv.search(Q);
  assert.equal(res.files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', `version 5 answers through its registered server: ${res.text.slice(0, 300)}`);
  await sv.close();

  // The write guard: off by default; on, with the server stopped, one line and the write goes through.
  const guardCmd = JSON.parse(fs.readFileSync(files.settings, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const project = ctx.tmp('rb5-w3-guard-');
  const write = () => runHost(guardCmd, { cwd: project, env: s.env, input: JSON.stringify(writeMsg(path.join(project, 'a.ts'), TERM_TEXT, emptyTranscript(ctx.tmp('rb5-w3-tr-')))) });
  assert.match(runCli(tree, s, ['guard', 'status']).stdout, /^guard off$/m, 'the guard is off by default');
  const off = write();
  assert.deepEqual([off.status, off.line], [0, ''], 'off: the hook says nothing and allows the write');
  assert.equal(runCli(tree, s, ['guard', 'on']).status, 0);
  const on = write();
  assert.equal(on.status, 0, `on, with the server stopped, the guard fails open: ${on.stderr}`);
  assert.equal(on.line.split('\n').length, 1, 'with exactly one line');
  assert.match(on.line, /advisory only: search is/);
  assert.equal(runCli(tree, s, ['guard', 'off']).status, 0);

  // The brake: every host file back to its pre-migration bytes; 4.7 untouched.
  const b = runCli(tree, s, ['rollback-to-4']);
  assert.equal(b.status, 0, `${b.stdout}${b.stderr}`);
  assert.deepEqual(userFiles(s), before, 'after rollback-to-4 the whole synthetic home (4.7 and every host file) has its pre-migration bytes');

  // --undo: version 5 registered again in every host and answering.
  const u = runCli(tree, s, ['rollback-to-4', '--undo']);
  assert.equal(u.status, 0, `${u.stdout}${u.stderr}`);
  for (const f of Object.values(files)) assert.ok(names(s, f), `--undo registers version 5 again in ${path.basename(f)}`);
  const sv2 = await serveRegistered(t, JSON.parse(fs.readFileSync(files.state, 'utf8')).mcpServers['ruvnet-brain-5'], { cwd: ctx.tmp('rb5-w3-proj-'), env: s.env });
  assert.equal((await sv2.search(Q)).files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', 'version 5 answers again after --undo');
  await sv2.close();
  assert.deepEqual(world47(s), before47, 'every 4.7 file is byte-identical at the end');

  // The retrieval gate: passes the synthetic set on the full pack, fails with one repository left out.
  const set = questionSet(ctx);
  pin(tree, setHash(tree, set));
  const good = gate(tree, ['--release', rel, '--questions', set, '--out', outFile(ctx)]);
  assert.equal(good.status, 0, `the retrieval gate passes the full synthetic pack: ${good.out}`);
  const out = outFile(ctx);
  const bad = gate(tree, ['--release', releaseOf(tree, ['alpha-vectors', 'beta-memory'].map(repo)), '--questions', set, '--out', out]);
  assert.notEqual(bad.status, 0, `the retrieval gate fails a pack missing one fixture repository: ${bad.out}`);
  assert.equal(readJson(out).passed, false);

  // The generated documents are current.
  const docs = gen(tree, '--check');
  assert.equal(docs.status, 0, `the generated documents are current: ${docs.out}`);
});
