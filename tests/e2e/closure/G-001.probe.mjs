#!/usr/bin/env node
// G-001 (PRIVACY, #370) — real Stop through the plugin's hook-shim in an isolated HOME with the real ruflo.
// A turn carrying a runtime-built token and a person name: zero raw token bytes in memory.db, its WAL,
// agentdb-memory.db, agentdb-turns.jsonl, receipts, dedupe state, spool and ruflo scratch, and in every
// process argv sampled while the worker runs. The name is kept out of every file EXCEPT the store row
// itself (token redaction cannot protect arbitrary private text — scope is owner decision D8) and out of
// argv. jsonl = {ts,key,hash,len} at 0600. A persisted opt-out takes effect on the next Stop (no restart).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OUTCOME, ROOT, adoptedRepo, filesContaining, fireStop, plant, realRuflo, recordingRuflo, report, rowsIn, sandbox } from './turn-capture-probe-lib.mjs';

await report('G-001', async (check) => {
  const ruflo = realRuflo();
  if (!ruflo) return { unknown: 'ruflo is not installed: the real write path cannot be exercised' };
  const box = sandbox('g001-');
  try {
    const { token, name, phrase } = plant();
    const repo = adoptedRepo(box, ruflo);
    const db = path.join(repo, '.swarm', 'memory.db');
    const text = `${OUTCOME} ${phrase}. The push used ${token} and the review is with ${name}.`;
    const recorder = recordingRuflo(box, ruflo);
    const run = await fireStop(box, { cwd: repo, ruflo: recorder.bin, text, needles: [token, name, phrase] });
    const store = run.receipts.find((r) => r.kind === 'store');
    check('the real worker wrote and read the row back by exact key', store?.ok === true && store?.readBack === 'verified', store);
    const stored = rowsIn(db);
    check('one turns row exists, redacted', stored.length === 1 && stored[0].content.includes('[REDACTED:token]'), stored.map((r) => r.key));
    const roots = [repo, box.home];
    check('zero raw token bytes in any file (memory.db, -wal, agentdb-memory.db, jsonl, receipts, dedupe, spool, scratch)',
      filesContaining(roots, token).length === 0, filesContaining(roots, token));
    const nameFiles = filesContaining(roots, name).map((f) => path.relative(box.root, f));
    check('the name is only in the store files (memory.db / its WAL), never in jsonl, receipts, spool or scratch',
      nameFiles.every((f) => /\.swarm\/memory\.db(-wal)?$/.test(f)), nameFiles);
    const calls = recorder.argv();
    check('ruflo was invoked (import + nothing else carrying text) and NO ruflo argv carried the token, the name or the turn text',
      calls.some((a) => a[1] === 'import') && calls.every((a) => ![token, name, phrase].some((n) => a.join(' ').includes(n))), calls.map((a) => a.slice(0, 2).join(' ')));
    check('no process argv sampled while the hook and its worker ran carried the token, the name or the turn text', run.argvLeaks.length === 0 && run.argvSamples > 1, { leaks: run.argvLeaks, samples: run.argvSamples });
    const jsonl = path.join(repo, '.swarm', 'agentdb-turns.jsonl');
    const line = JSON.parse(fs.readFileSync(jsonl, 'utf8').trim());
    check('agentdb-turns.jsonl holds only {ts,key,hash,len}', JSON.stringify(Object.keys(line)) === '["ts","key","hash","len"]', Object.keys(line));
    if (process.platform !== 'win32') {
      const modes = Object.fromEntries([jsonl, path.join(box.brainHome, 'turn-capture', 'receipts.jsonl'), path.join(box.brainHome, 'turn-capture', 'last-turn.json')]
        .map((f) => [path.basename(f), (fs.statSync(f).mode & 0o777).toString(8)]));
      check('capture files are created 0600', Object.values(modes).every((m) => m === '600'), modes);
      const dirs = Object.fromEntries([path.join(box.brainHome, 'turn-capture'), path.join(box.brainHome, 'turn-capture', 'spool')]
        .map((d) => [path.basename(d), (fs.statSync(d).mode & 0o777).toString(8)]));
      check('capture directories are 0700', Object.values(dirs).every((m) => m === '700'), dirs);
    }
    // Persisted opt-out, set by the shipped command, honoured by the very next Stop of the same "session".
    const set = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'turn-capture-state.mjs'), '--capture', 'off', '--project', repo],
      { env: { ...box.gitEnv }, encoding: 'utf8' });
    check('the opt-out command persisted the setting', set.status === 0, set.stdout.trim() || set.stderr.trim());
    const after = await fireStop(box, { cwd: repo, ruflo: recorder.bin, text: `${OUTCOME} A second, different outcome.`, timeoutMs: 4000 });
    check('a persisted per-project opt-out takes effect on the next Stop without restart', after.receipts.length === 0 && rowsIn(db).length === 1,
      { receipts: after.receipts.length, rows: rowsIn(db).length });
    return null;
  } finally { box.cleanup(); }
});
