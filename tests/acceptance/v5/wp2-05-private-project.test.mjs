// WP2 T5: the server passes the project a question comes from to the engine's private-pack check.
// A private pack in <home>/private/ is searched only from a listed project folder (or a folder inside
// one), and never otherwise: from an unlisted folder (a sibling with the same name prefix, the parent,
// an unrelated folder) the answer is the same, byte for byte apart from the fence marker, as with no
// private pack at all. When the client offers roots, its first root is the project.
// Breaks: the server passes no project; the private search uses the pack's own listed project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readStatus, setup, sleep, waitFor } from './helpers.mjs';
import { installPrivate, unfenced, writeRepo } from './wp2-helpers.mjs';

const Q = 'saltmarrow pricing episode store';
const PRIVATE_FILE = 'private:notes/owner-notes/meetings/notes.md'; // F17: private items cite their pack

/** Re-initialise a running server as a client that offers roots, and answer its roots request. */
async function withRoots(srv, folder) {
  readline.createInterface({ input: srv.child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'roots/list') srv.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [{ uri: pathToFileURL(folder).href, name: 'project' }] } }) + '\n');
  });
  await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'v5-roots', version: '1' } });
  srv.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await sleep(500);
}

test('WP2 T5 a private pack is searched only from a listed project', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-05');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const base = ctx.tmp('rb5-projects-');
  const listed = path.join(base, 'client-work');
  const inside = path.join(listed, 'src', 'deep');
  const sibling = path.join(base, 'client-work-old');
  const elsewhere = path.join(base, 'side-project');
  for (const d of [inside, sibling, elsewhere]) fs.mkdirSync(d, { recursive: true });

  // The answers with no private pack installed: what every unlisted folder must still get.
  const before = {};
  for (const [name, cwd] of Object.entries({ sibling, parent: base, elsewhere })) {
    const s = await ctx.server(tree, home, { cwd });
    before[name] = await s.search(Q);
    assert.ok(before[name].files.some((f) => f.file === 'beta-memory/src/episode_store.ts'));
    await s.close();
  }

  const notes = writeRepo(ctx.tmp('rb5-notes-'), 'owner-notes', { 'meetings/notes.md': '# Meeting\n\nThe saltmarrow pricing was agreed with the client on Tuesday.\n' });
  installPrivate(home, tree.build([notes]), 'notes', [listed]);

  for (const cwd of [listed, inside]) {
    const s = await ctx.server(tree, home, { cwd });
    const r = await s.search(Q);
    assert.ok(r.files.some((f) => f.file === PRIVATE_FILE), `the private pack must be searched from its listed project ${cwd}: ${JSON.stringify(r.files.map((f) => f.file))}`);
    assert.match(r.text, /saltmarrow pricing was agreed/);
    assert.ok(r.files.some((f) => f.file === 'beta-memory/src/episode_store.ts'), 'the installed pack still answers');
    await s.close();
  }
  for (const [name, cwd] of Object.entries({ sibling, parent: base, elsewhere })) {
    const s = await ctx.server(tree, home, { cwd });
    const r = await s.search(Q);
    assert.ok(!r.files.some((f) => f.file === PRIVATE_FILE) && !/saltmarrow pricing/.test(r.text), `a private pack must never be searched from ${name} (${cwd})`);
    assert.equal(unfenced(r.text), unfenced(before[name].text), `from ${name} the answer must be what it was with no private pack`);
    const st = readStatus(home, s.pid);
    assert.doesNotMatch(JSON.stringify(st), /saltmarrow|owner-notes/, 'the status file names nothing private');
    await s.close();
  }

  // Roots: the client's first root is the project, whatever folder the server was started in.
  const viaRoots = await ctx.server(tree, home, { cwd: elsewhere });
  await withRoots(viaRoots, inside);
  assert.ok((await viaRoots.search(Q)).files.some((f) => f.file === PRIVATE_FILE), 'a listed root opens the private pack');
  const rootsOut = await ctx.server(tree, home, { cwd: listed });
  await withRoots(rootsOut, sibling);
  const ro = await rootsOut.search(Q);
  assert.ok(!ro.files.some((f) => f.file === PRIVATE_FILE), 'an unlisted root closes it, even from a listed start folder');
  await waitFor(() => readStatus(home, rootsOut.pid)?.probe?.ok, 10_000, 'the self-test');
});
