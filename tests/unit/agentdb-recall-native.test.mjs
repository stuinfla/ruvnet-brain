import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recall } from '../../plugin/scripts/agentdb-recall.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

it('prunes empty namespaces and reads exact values without additional CLI boots or mutation', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-native-')));
  const proj = path.join(dir, 'proj'); const db = path.join(proj, '.swarm/memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const content = 'Require useful recall on every nontrivial prompt.';
  const bin = path.join(dir, 'ruflo'); const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'), args = process.argv.slice(2);
fs.appendFileSync(process.env.RECALL_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'retrieve') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
console.log(JSON.stringify({results:[{key:'decision-requirements',namespace:'proj',score:0.8}]}));
`, { mode: 0o755 });
  const env = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_BRAIN_HOME: path.join(dir, 'brain'), RECALL_LOG: log };
  try {
    const seeded = spawnSync(resolveRuflo({ env: process.env }), ['memory', 'store', '--path', db,
      '--namespace', 'proj', '--key', 'decision-requirements', '--value', content],
    { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    expect(seeded.status, seeded.stderr).toBe(0);
    const before = fs.readFileSync(db);
    const result = await recall({ prompt: 'Fix parser', projectDir: proj, env: { ...env, RUFLO_BIN: bin } });
    expect(result.outcome, JSON.stringify(result)).toBe('ok-with-results');
    expect(result.block).toContain('Require useful recall');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls.every(args => args[1] === 'search')).toBe(true);
    expect(calls.map(args => args[args.indexOf('-n') + 1])).toEqual(['proj']);
    expect(fs.readFileSync(db)).toEqual(before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
