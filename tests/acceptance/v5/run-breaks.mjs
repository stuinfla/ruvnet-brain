// Runs each skeleton acceptance test once as written (must pass) and once per break in breaks.mjs
// (must fail, and with the expected failure). One test process at a time; waits while the machine's
// 1-minute load average is above 60.   node tests/acceptance/v5/run-breaks.mjs [s01 s05 ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BREAKS } from './breaks.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = fs.readdirSync(DIR).filter((f) => /^s\d\d-.*\.test\.mjs$/.test(f)).sort();

async function calm() {
  while (os.loadavg()[0] > 60) {
    console.log(`load ${os.loadavg()[0].toFixed(1)} > 60; waiting 30 s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function run(file, brk) {
  const env = { ...process.env };
  delete env.V5_BREAK;
  if (brk) env.V5_BREAK = brk;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(DIR, file)], { env, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const lines = out.split('\n');
  const err = lines.findIndex((l) => /AssertionError|^\s*Error:|\bError \[/.test(l));
  const key = err >= 0 ? lines.slice(err, err + 2).join(' ').replace(/\s+/g, ' ').trim() : (lines.find((l) => /^[✔✖]/.test(l)) ?? '').trim();
  return { pass: r.status === 0, out, key: key.slice(0, 260) };
}

let bad = 0;
const rows = [];
for (const file of files) {
  const id = file.slice(0, 3);
  if (only.length && !only.includes(id)) continue;
  await calm();
  const g = run(file, null);
  if (!g.pass) bad++;
  rows.push(`${id}  green: ${g.pass ? 'PASS' : 'FAIL'}  ${g.key}`);
  console.log(rows.at(-1));
  for (const [name, b] of Object.entries(BREAKS).filter(([, b]) => b.test === id)) {
    await calm();
    const r = run(file, name);
    const red = !r.pass && b.expect.test(r.out);
    if (!red) bad++;
    rows.push(`${id}  break ${name} (${b.what}): ${red ? 'RED as expected' : r.pass ? 'STILL GREEN' : 'red for another reason'}  ${r.key}`);
    console.log(rows.at(-1));
  }
}
console.log(`\n${bad ? `${bad} problem(s)` : 'every test passes and every break turns its test red'}`);
process.exitCode = bad ? 1 : 0;
