// Review F08: private access is fail-closed and never cached past a change.
// - A client that declares roots: until it has answered the roots request, no private pack is searched,
//   even when the server was started inside a listed project.
// - A roots answer with no file: root (an empty list) revokes access a previous root gave.
// - A private pack's project list is read again for each question: removing the project from PACK.json
//   closes the pack for the next search on the same server.
// Breaks: the start folder counts while roots are pending; an empty roots list keeps the old project;
// the private packs are opened once per worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setup, sleep } from './helpers.mjs';
import { installPrivate, writeRepo } from './wp2-helpers.mjs';

const Q = 'saltmarrow pricing episode store';
const SECRET = /saltmarrow pricing was agreed/;

/** Makes a running server's client one that declares roots; `answer()` gives each roots/list reply (null: none). */
async function rootsClient(srv, answer) {
  readline.createInterface({ input: srv.child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method !== 'roots/list') return;
    const roots = answer();
    if (roots) srv.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots } }) + '\n');
  });
  await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'v5-roots', version: '1' } });
  srv.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await sleep(500);
}

test('F08 private access is fail-closed: pending roots, removed roots, an edited project list', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'integ-server-f08');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  const listed = path.join(ctx.tmp('rb5-projects-'), 'client-work');
  fs.mkdirSync(listed, { recursive: true });
  const notes = writeRepo(ctx.tmp('rb5-notes-'), 'owner-notes', { 'meetings/notes.md': '# Meeting\n\nThe saltmarrow pricing was agreed with the client on Tuesday.\n' });
  const priv = installPrivate(home, tree.build([notes]), 'notes', [listed]);

  // Pending: the client declares roots and has not answered; the listed start folder does not count.
  const pending = await ctx.server(tree, home, { cwd: listed });
  await rootsClient(pending, () => null);
  assert.doesNotMatch((await pending.search(Q)).text, SECRET, 'a private pack was searched while the roots request was pending');
  await pending.close();

  // Removed: a listed root opens the pack; an empty roots list closes it again.
  let roots = [{ uri: pathToFileURL(listed).href, name: 'project' }];
  const changing = await ctx.server(tree, home, { cwd: listed });
  await rootsClient(changing, () => roots);
  assert.match((await changing.search(Q)).text, SECRET, 'a listed root opens the private pack');
  roots = [];
  changing.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }) + '\n');
  await sleep(500);
  assert.doesNotMatch((await changing.search(Q)).text, SECRET, 'an empty roots list must revoke private access');
  await changing.close();

  // Edited list: the same server, the project taken off the pack's list between two questions.
  const srv = await ctx.server(tree, home, { cwd: listed });
  assert.match((await srv.search(Q)).text, SECRET, 'the listed start folder opens the pack (no roots declared)');
  const file = path.join(priv, 'PACK.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), projects: [] }, null, 2));
  assert.doesNotMatch((await srv.search(Q)).text, SECRET, 'a project taken off the list must lose access at the next search');
});
