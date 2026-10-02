// A fake global ruflo for the AgentDB-first tests (ADR-0101). It speaks the real
// `ruflo memory search --format json` shape (log lines, then one JSON object with `results`), reads its
// rows from `<--path>.rows.json`, writes into its cwd the way real ruflo does (so cwd isolation is
// observable), can be made slow (FAKE_RUFLO_SLEEP_MS) to drive the deadline, and logs every call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2); const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
if (process.env.FAKE_RUFLO_LOG) fs.appendFileSync(process.env.FAKE_RUFLO_LOG, JSON.stringify({ cwd: process.cwd(), args: a, daemon: process.env.RUFLO_DAEMON_AUTOSTART }) + '\\n');
fs.writeFileSync(path.join(process.cwd(), 'ruvector.db'), 'x');
const ms = Number(process.env.FAKE_RUFLO_SLEEP_MS || 0); if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let rows = []; try { rows = JSON.parse(fs.readFileSync(get('--path') + '.rows.json', 'utf8')); } catch {}
const q = get('-q'); const kw = a.includes('-t');
console.log('[INFO] Searching: ' + q);
console.log(JSON.stringify({ query: q, results: rows.filter((r) => !kw || r.key.includes(q)) }));
`;

export const PLAN = Object.freeze({ key: 'plan-4.5-test', namespace: 'default', preview: 'THE 4.5 PLAN' });
export const CARD = Object.freeze({ key: 'scorecard-2026-10-01', namespace: 'ruvnet-brain', preview: 'SCORECARD 46/100' });

export function fakeWorld({ stores = { 'memory.db': [], 'agentdb-memory.db': [] } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-first-')));
  const proj = path.join(dir, 'proj');
  const swarm = path.join(proj, '.swarm');
  fs.mkdirSync(swarm, { recursive: true });
  for (const [name, rows] of Object.entries(stores)) {
    fs.writeFileSync(path.join(swarm, name), '');
    fs.writeFileSync(path.join(swarm, `${name}.rows.json`), JSON.stringify(rows));
  }
  const ruflo = path.join(dir, 'ruflo');
  fs.writeFileSync(ruflo, FAKE, { mode: 0o755 });
  const log = path.join(dir, 'ruflo.log');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: path.join(dir, 'bh'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'), RUFLO_BIN: ruflo, FAKE_RUFLO_LOG: log };
  const calls = () => {
    try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { dir, proj, swarm, ruflo, env, calls };
}
