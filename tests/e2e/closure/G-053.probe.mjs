#!/usr/bin/env node
// G-053 (SECURITY) — the turn writer is contained to the canonical adopted root. Real hook-shim Stop, real
// ruflo, isolated HOME. Fixtures: `.swarm` directory symlink, `memory.db` file symlink, hard link, WAL side
// file symlink, and the replacement race (the store swapped for a symlink after the hook chose it, then the
// REAL worker process runs with exactly the steps the hook queued). Each: 0 writes outside the canonical
// adopted root (the foreign tree is byte-identical afterwards), no automatic global fallback.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { OUTCOME, ROOT, adoptedRepo, fireStop, initStore, plant, realRuflo, report, rowsIn, sandbox } from './turn-capture-probe-lib.mjs';

const treeDigest = (dir) => {
  const h = crypto.createHash('sha256');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name); h.update(p);
    if (e.isDirectory()) walk(p); else if (e.isFile()) h.update(fs.readFileSync(p));
  } };
  walk(dir);
  return h.digest('hex');
};

await report('G-053', async (check) => {
  const ruflo = realRuflo();
  if (!ruflo) return { unknown: 'ruflo is not installed: the real write path cannot be exercised' };
  const box = sandbox('g053-');
  try {
    const foreignRoot = path.join(box.root, 'foreign');
    initStore(box, ruflo, path.join(foreignRoot, '.swarm', 'memory.db'));
    const foreignDb = path.join(foreignRoot, '.swarm', 'memory.db');
    const fixtures = {
      'directory symlink': (repo) => { fs.rmSync(path.join(repo, '.swarm'), { recursive: true }); fs.symlinkSync(path.dirname(foreignDb), path.join(repo, '.swarm')); },
      'file symlink': (repo) => { fs.rmSync(path.join(repo, '.swarm', 'memory.db')); fs.symlinkSync(foreignDb, path.join(repo, '.swarm', 'memory.db')); },
      'hard link': (repo) => { fs.rmSync(path.join(repo, '.swarm', 'memory.db')); fs.linkSync(foreignDb, path.join(repo, '.swarm', 'memory.db')); },
      'WAL side-file symlink': (repo) => { fs.writeFileSync(path.join(foreignRoot, 'victim-wal'), ''); fs.symlinkSync(path.join(foreignRoot, 'victim-wal'), path.join(repo, '.swarm', 'memory.db-wal')); },
    };
    let n = 0;
    for (const [label, plantFixture] of Object.entries(fixtures)) {
      const repo = adoptedRepo(box, ruflo, `repo-${n += 1}`);
      plantFixture(repo);
      const digest = treeDigest(foreignRoot);
      const run = await fireStop(box, { cwd: repo, ruflo, text: `${OUTCOME} ${plant().phrase}`, timeoutMs: 20_000 });
      const refusal = run.receipts.find((r) => r.kind === 'store');
      check(`${label}: refused with a failing receipt`, refusal?.ok === false && /store refused/.test(refusal?.error || ''), refusal);
      check(`${label}: the foreign tree is byte-identical (0 writes outside the canonical root)`, treeDigest(foreignRoot) === digest && rowsIn(foreignDb).length === 0);
      check(`${label}: no global fallback`, !fs.existsSync(path.join(box.home, '.claude', 'global-memory')));
    }

    // Replacement race. The hook (real code) chooses and queues; then the store is swapped; then the REAL
    // worker process runs with the exact argv launchDetached would give it.
    const repo = adoptedRepo(box, ruflo, 'repo-race');
    const { captureTurnOutcome } = await import(pathToFileURL(path.join(ROOT, 'plugin', 'scripts', 'turn-outcome-capture.mjs')).href);
    let queued = null;
    const r = captureTurnOutcome({ projectDir: repo, event: 'Stop', host: 'claude', env: {}, home: box.home, brainHome: box.brainHome, ruflo,
      payload: { session_id: 'race', last_assistant_message: `${OUTCOME} race` }, launch: (steps, opts) => { queued = { steps, receipts: opts.receipts }; return {}; } });
    check('race: the hook queued a write to the canonical store', r.queued === true && queued?.steps?.[0]?.db === path.join(repo, '.swarm', 'memory.db'), r.skipped);
    fs.renameSync(path.join(repo, '.swarm'), path.join(repo, '.swarm-moved'));
    fs.symlinkSync(path.dirname(foreignDb), path.join(repo, '.swarm'));
    const digest = treeDigest(foreignRoot);
    const worker = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'turn-outcome-capture.mjs'), '--run-steps', JSON.stringify(queued)],
      { cwd: box.root, env: { ...box.gitEnv, RUFLO_DAEMON_AUTOSTART: '0' }, encoding: 'utf8', timeout: 120_000 });
    const receipt = fs.readFileSync(queued.receipts, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.key === queued.steps[0].key).pop();
    check('race: the real worker re-checked and refused before writing', worker.status === 0 && receipt?.ok === false && /refused before write/.test(receipt?.error || ''), receipt);
    check('race: the foreign tree is byte-identical', treeDigest(foreignRoot) === digest && rowsIn(foreignDb).length === 0);
    check('race: the moved original store got nothing either', rowsIn(path.join(repo, '.swarm-moved', 'memory.db')).length === 0);
    check('race: no global fallback', !fs.existsSync(path.join(box.home, '.claude', 'global-memory')));
    return null;
  } finally { box.cleanup(); }
});
