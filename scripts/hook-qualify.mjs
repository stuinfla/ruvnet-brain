#!/usr/bin/env node
// hook-qualify.mjs — qualify every registered hook against the host contract it runs under.
//
//   (defaults: --repeat 10 --concurrent 2 so a busy machine is not hammered; the owner's full ask is --repeat 50 --concurrent 20)
//   node scripts/hook-qualify.mjs                      Layer 1 for claude+codex+grok (offline, deterministic)
//   node scripts/hook-qualify.mjs --layer2 claude,codex,grok   real-host smoke, ONE turn each
//   node scripts/hook-qualify.mjs --hosts codex --cases baseline-real,empty-stdin --repeat 5 --concurrent 5
//   node scripts/hook-qualify.mjs --measure            bytes injected per prompt by SessionStart+UserPromptSubmit
//   node scripts/hook-qualify.mjs --json out.json      machine-readable matrix
//
// Exit 0 only when every row is PASS. A qualification that cannot run (no sandbox, host not signed in)
// is reported as SKIP/BLOCKED with the reason — never as PASS.
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  CASES, HOSTS, auditWrites, fixturesFor, measureInjection, registrations, runCase, runConcurrent, runRepeat,
  sandboxAvailable, staticFindings,
} from './hook-qualify-core.mjs';

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };

export async function layer1({ hosts = HOSTS, cases = null, repeat = 50, concurrent = 20, log = () => {} } = {}) {
  const regs = registrations(undefined, hosts);
  const rows = [];
  for (const f of staticFindings(regs)) rows.push({ reg: f.reg, kind: 'static', pass: false, findings: [f.msg] });
  const selected = CASES.filter((c) => !cases || cases.includes(c.name));
  for (const reg of regs) {
    const fixes = fixturesFor(reg);
    if (!fixes.length) { rows.push({ reg, kind: 'fixture', pass: false, findings: [`no captured payload for ${reg.host}/${reg.event} matcher ${reg.matcher}`] }); continue; }
    const fix = fixes[0];
    log(`  ${reg.label}`);
    const runs = [];
    for (const c of selected) runs.push(await runCase(reg, fix, c));
    const failed = runs.filter((r) => r.findings.length);
    const base = runs.find((r) => r.case === 'baseline-real');
    const row = { reg, kind: 'matrix', fixture: fix.name, provenance: fix._provenance, cases: runs.length, failed: failed.length,
      skipped: runs.filter((r) => r.skipped).map((r) => r.case), p50: pct(runs.map((r) => r.ms), 0.5), max: Math.max(...runs.map((r) => r.ms)),
      baselineMs: base?.ms, baselineBytes: base?.stdout.length, failures: failed.map((r) => ({ case: r.case, findings: r.findings })) };
    if (repeat && (!cases || cases.includes('repeat'))) { const rp = await runRepeat(reg, fix, repeat); row.repeat = { n: repeat, growth: rp.growth, firstMs: rp.firstMs, lastMs: rp.lastMs, p95: pct(rp.runs.map((r) => r.ms), 0.95), failed: rp.runs.filter((r) => r.findings.length).length, sample: rp.runs.find((r) => r.findings.length)?.findings }; }
    if (concurrent && (!cases || cases.includes('concurrent'))) { const cr = await runConcurrent(reg, fix, concurrent); row.concurrent = { n: concurrent, maxMs: Math.max(...cr.map((r) => r.ms)), failed: cr.filter((r) => r.findings.length).length, sample: cr.find((r) => r.findings.length)?.findings }; }
    if (!cases || cases.includes('write-audit')) row.writes = await auditWrites(reg, fix);
    row.pass = !failed.length && !(row.repeat?.failed) && !(row.concurrent?.failed) && !row.writes?.violated;
    rows.push(row);
  }
  return rows;
}

export function render(rows) {
  const out = [];
  out.push('HOST   EVENT             HOOK                          RESULT  cases  base(ms) p50/max(ms)  timeout(s)  bytes  x20max  growth(50x)   writes');
  for (const r of rows) {
    if (r.kind !== 'matrix') { out.push(`${r.reg.host.padEnd(6)} ${r.reg.event.padEnd(17)} ${r.reg.label.split('/').slice(2).join('/').padEnd(29)} FAIL    ${r.kind}: ${r.findings[0]}`); continue; }
    const g = r.repeat ? `${r.repeat.growth.files}f/${r.repeat.growth.bytes}B` : '-';
    const w = r.writes?.skipped ? `SKIP(${r.writes.skipped.slice(0, 18)})` : r.writes ? (r.writes.violated ? 'VIOLATION' : 'ok') : '-';
    out.push(`${r.reg.host.padEnd(6)} ${r.reg.event.padEnd(17)} ${r.reg.label.split('/').slice(2).join('/').padEnd(29)} ${(r.pass ? 'PASS' : 'FAIL').padEnd(7)} ${String(r.cases - r.failed).padStart(2)}/${String(r.cases).padEnd(3)} ${String(r.baselineMs).padStart(7)} ${`${r.p50}/${r.max}`.padStart(12)}  ${String(r.reg.effectiveSec).padStart(6)}/${r.reg.timeoutSec}  ${String(r.baselineBytes).padStart(5)}  ${String(r.concurrent?.maxMs ?? '-').padStart(6)}  ${g.padEnd(13)} ${w}`);
  }
  const bad = rows.filter((r) => !r.pass);
  if (bad.length) out.push('', 'FAILURES');
  for (const r of bad) {
    out.push(`- ${r.reg.label}`);
    for (const f of r.findings || []) out.push(`    ${f}`);
    for (const f of r.failures || []) out.push(`    [${f.case}] ${f.findings.join(' | ')}`);
    if (r.repeat?.failed) out.push(`    [repeat x${r.repeat.n}] ${r.repeat.failed} failing: ${(r.repeat.sample || []).join(' | ')}`);
    if (r.concurrent?.failed) out.push(`    [concurrent x${r.concurrent.n}] ${r.concurrent.failed} failing: ${(r.concurrent.sample || []).join(' | ')}`);
    if (r.writes?.violated) out.push('    [write-audit] wrote outside the isolated HOME/cwd (killed by the sandbox)');
  }
  return out.join('\n');
}

async function main() {
  const hosts = String(arg('hosts', HOSTS.join(','))).split(',');
  const cases = arg('cases') ? String(arg('cases')).split(',') : null;
  if (arg('measure')) {
    for (const h of hosts.filter((x) => x !== 'grok')) {
      console.log(`== bytes injected by SessionStart + UserPromptSubmit hooks (${h}) ==`);
      for (const row of await measureInjection(h)) console.log(`${String(row.totalBytes).padStart(6)} B  ${JSON.stringify(row.prompt)}  ${row.perHook.map((p) => `${p.hook.split('/').slice(1).join('/')}=${p.bytes}`).join('  ')}`);
    }
    return 0;
  }
  if (arg('layer2')) {
    const { layer2 } = await import('./hook-qualify-hosts.mjs');
    const res = await layer2(String(arg('layer2')).split(','), { maxLoad: Number(arg('max-load', 40)), log: console.log });
    console.log(JSON.stringify(res, null, 1));
    return res.every((r) => r.status === 'PASS') ? 0 : 1;
  }
  if (!sandboxAvailable()) console.log('NOTE: sandbox-exec unavailable — the no-network and write-containment guards are SKIPPED, not passed.');
  console.log(`load ${os.loadavg().map((x) => x.toFixed(1)).join(' ')} (timing assertions assume an idle machine)`);
  const rows = await layer1({ hosts, cases, repeat: Number(arg('repeat', 10)), concurrent: Number(arg('concurrent', 2)), log: console.error });
  console.log(render(rows));
  if (arg('json')) fs.writeFileSync(String(arg('json')), JSON.stringify(rows, (k, v) => (k === 'body' ? undefined : v), 1));
  return rows.every((r) => r.pass) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
