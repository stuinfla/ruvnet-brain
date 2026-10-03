#!/usr/bin/env node
// G-002 (PRIVACY, #370) — real hook-shim Stop, real ruflo, isolated HOME.
//   1. A Stop from a linked git worktree writes to <repo>/.swarm/memory.db, tagged project=<repo name>,
//      with 0 rows (indeed no file) in the machine-wide store.
//   2. A project without .swarm writes NOTHING anywhere unless opted in (the conservative default while
//      owner decision D8 is pending); with the documented opt-in it records machine-wide.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OUTCOME, ROOT, adoptedRepo, fireStop, git, plant, realRuflo, report, rowsIn, sandbox } from './turn-capture-probe-lib.mjs';

await report('G-002', async (check) => {
  const ruflo = realRuflo();
  if (!ruflo) return { unknown: 'ruflo is not installed: the real write path cannot be exercised' };
  const box = sandbox('g002-');
  try {
    const globalDir = path.join(box.home, '.claude', 'global-memory');
    const repo = adoptedRepo(box, ruflo, 'canon-repo');
    const wt = path.join(box.root, 'linked-wt');
    git(repo, box.gitEnv, 'worktree', 'add', '-q', '-b', 'probe-branch', wt);
    const run = await fireStop(box, { cwd: wt, ruflo, text: `${OUTCOME} ${plant().phrase}` });
    const store = run.receipts.find((r) => r.kind === 'store');
    check('the worktree turn was written and read back by exact key', store?.ok === true && store?.db === path.join(repo, '.swarm', 'memory.db'), store);
    const rows = rowsIn(path.join(repo, '.swarm', 'memory.db'));
    check('the canonical store holds it, tagged with the repository name', rows.length === 1 && rows[0].content.includes('project=canon-repo '), rows.map((r) => r.content.slice(0, 80)));
    check('the worktree got no .swarm of its own', !fs.existsSync(path.join(wt, '.swarm')));
    check('0 rows in the machine-wide store (it was never created)', !fs.existsSync(globalDir));

    const bare = path.join(box.root, 'bare-project');
    fs.mkdirSync(bare);
    const none = await fireStop(box, { cwd: bare, ruflo, text: `${OUTCOME} ${plant().phrase}`, timeoutMs: 4000 });
    check('a project without .swarm: no store receipt, no global store, no .swarm created',
      none.receipts.filter((r) => r.kind === 'store').length === 0 && !fs.existsSync(globalDir) && !fs.existsSync(path.join(bare, '.swarm')), none.receipts);

    const opt = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'turn-capture-state.mjs'), '--unadopted', 'global'], { env: box.gitEnv, encoding: 'utf8' });
    check('the documented opt-in is accepted', opt.status === 0, opt.stdout.trim() || opt.stderr.trim());
    const opted = await fireStop(box, { cwd: bare, ruflo, text: `${OUTCOME} ${plant().phrase}` });
    const optedStore = opted.receipts.find((r) => r.kind === 'store');
    check('opted in: the bare project records machine-wide, verified', optedStore?.ok === true && rowsIn(path.join(globalDir, '.swarm', 'memory.db')).length === 1, optedStore);
    return null;
  } finally { box.cleanup(); }
});
