import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recall, BLOCK_MAX_BYTES } from '../../plugin/scripts/agentdb-recall.mjs';
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

// Curated exact records are read natively BEFORE ranked search and must survive its failure or emptiness,
// inside the 600-byte prompt-path limit (ADR-105 rule 4).
function curatedWorld(mode) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recall-curated-')));
  const proj = path.join(dir, 'proj'); const db = path.join(proj, '.swarm/memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const bin = path.join(dir, 'ruflo');
  fs.writeFileSync(bin, `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.RECALL_MODE === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
console.log(JSON.stringify({results: process.env.RECALL_MODE === 'low' ? [{key:'unrelated-note',namespace:'proj',score:0.1}] : []}));
`, { mode: 0o755 });
  const env = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_BRAIN_HOME: path.join(dir, 'brain'), RECALL_MODE: mode };
  const store = (namespace, key, value) => {
    const r = spawnSync(resolveRuflo({ env: process.env }), ['memory', 'store', '--path', db, '--namespace', namespace, '--key', key, '--value', value],
      { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
    expect(r.status, r.stderr).toBe(0);
  };
  const long = (word) => `${word} `.repeat(70).trim(); // ~350 bytes of distinctive text
  store('proj', 'project-state-current-1700000000000', JSON.stringify({ status: 'qualified', nextAction: 'Finish the parser audit. ' + long('parser') }));
  store('proj', 'decision-parser-one', 'We decided the parser keeps strict mode. ' + long('parser'));
  store('default', 'decision-parser-two', 'We decided the parser rejects trailing commas. ' + long('parser'));
  return { dir, proj, env: { ...env, RUFLO_BIN: bin } };
}

for (const mode of ['hang', 'low']) {
  it(`delivers exact curated records within 600 bytes when ranked search is ${mode === 'hang' ? 'hung' : 'below threshold'}`, async () => {
    const w = curatedWorld(mode);
    try {
      const r = await recall({ prompt: 'What did we decide about the parser?', projectDir: w.proj, env: w.env });
      expect(r.picks.length).toBeGreaterThanOrEqual(1);
      expect(r.picks.some(p => p.key === 'project-state-current-1700000000000'), JSON.stringify(r.picks.map(p => p.key))).toBe(true);
      expect(r.block).toContain('project-state-current-1700000000000');
      expect(Buffer.byteLength(r.block + '\n')).toBeLessThanOrEqual(BLOCK_MAX_BYTES);
      if (mode === 'low') expect(r.outcome).toBe('ok-with-results');
      expect(r.receipt.records.every(rec => /^[a-f0-9]{64}$/.test(rec.valueDigest))).toBe(true);
    } finally { fs.rmSync(w.dir, { recursive: true, force: true }); }
  }, 30000);
}
