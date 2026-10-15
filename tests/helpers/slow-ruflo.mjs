// A stub `ruflo` for latency and loud-failure tests: logs every argv (JSONL), sleeps RUFLO_STUB_DELAY_MS on
// `memory store|list|distill` (or every call with RUFLO_STUB_DELAY_ALL=1), refuses stores with RUFLO_STUB_REFUSE=1,
// honours --no-upsert like rUv's store (an existing key is refused), and keeps stored values in one JSON file so `memory retrieve --value-only` reads back the exact bytes.
import fs from 'node:fs';
import path from 'node:path';

export function slowRuflo(dir, { delayMs = 0, delayAll = false, refuse = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ruflo');
  const log = path.join(dir, 'calls.jsonl');
  const values = path.join(dir, 'values.json');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const flag = (...names) => { for (const n of names) { const i = a.indexOf(n); if (i >= 0) return a[i + 1]; } return undefined; };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, at: Date.now(), pid: process.pid }) + '\\n');
const slow = ${delayAll ? 'true' : "['store', 'list', 'distill'].includes(a[1])"};
if (slow && ${delayMs}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});
let v = {}; try { v = JSON.parse(fs.readFileSync(${JSON.stringify(values)}, 'utf8')); } catch {}
const id = (flag('--namespace', '-n') || '') + '/' + flag('--key', '-k');
if (a[1] === 'store') { if (${refuse}) { console.error('[ERROR] refusing an unsafe write'); process.exit(1); }
  if (a.includes('--no-upsert') && id in v) { console.error('[ERROR] immutable append rejected: logical key already exists'); process.exit(1); }
  v[id] = flag('--value'); fs.writeFileSync(${JSON.stringify(values)}, JSON.stringify(v)); console.log('[OK] stored'); process.exit(0); }
if (a[1] === 'retrieve') { if (!(id in v)) process.exit(1); process.stdout.write(v[id]); process.exit(0); }
if (a[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { bin, log, calls };
}

export const ledgerRows = (brainHome) => {
  try { return fs.readFileSync(path.join(brainHome, 'hook-failures.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

export async function until(predicate, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return predicate();
}

export const storedRows = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'values.json'), 'utf8')); } catch { return {}; } };
