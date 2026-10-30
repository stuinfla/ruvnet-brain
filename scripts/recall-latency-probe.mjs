#!/usr/bin/env node
/**
 * Measures the real hook paths against a real store (#429): prompt-time recall() and SessionStart restore().
 *   node scripts/recall-latency-probe.mjs --project <repo> [--runs N]
 * Prints per-run milliseconds, outcome and `uptime` (machine load). Exit 1 unless EVERY prompt recall is
 * ok-with-results / ok-empty within 1900 ms and EVERY restore is 'restored' within 3500 ms. The thresholds are
 * the product's budgets, not tuned to the machine.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { recall } from '../plugin/scripts/agentdb-recall.mjs';
import { restore } from '../plugin/scripts/ruflo-memory-hooks.mjs';

export const RECALL_LIMIT_MS = 1900;
export const RESTORE_LIMIT_MS = 3500;
const PROMPT = 'Where are we on the recall latency work? Catch me up on the last decision.';

const argValue = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const uptime = () => { try { return execFileSync('uptime', { encoding: 'utf8' }).trim(); } catch { return 'uptime unavailable'; } };

async function main() {
  const project = argValue('--project');
  const runs = Number(argValue('--runs') ?? 5);
  if (!project || !Number.isInteger(runs) || runs < 1) {
    console.error('usage: recall-latency-probe.mjs --project <repo> [--runs N]');
    process.exit(2);
  }
  const dir = path.resolve(project);
  let failures = 0;
  for (let run = 1; run <= runs; run += 1) {
    const t0 = Date.now();
    const r = await recall({ prompt: PROMPT, projectDir: dir });
    const recallMs = Date.now() - t0;
    const recallOk = ['ok-with-results', 'ok-empty'].includes(r.outcome) && recallMs <= RECALL_LIMIT_MS;
    const t1 = Date.now();
    const s = await restore({ cwd: dir });
    const restoreMs = Date.now() - t1;
    const restoreOk = s.status === 'restored' && restoreMs <= RESTORE_LIMIT_MS;
    if (!recallOk) failures += 1;
    if (!restoreOk) failures += 1;
    console.log(`run ${run}: recall ${recallMs} ms ${r.outcome}${r.status?.['memory.db'] && r.outcome !== 'ok-with-results' ? ` [${r.status['memory.db']}]` : ''}${r.reason ? ` (${r.reason})` : ''} ${recallOk ? 'PASS' : 'FAIL'}`
      + ` | restore ${restoreMs} ms ${s.status} ${restoreOk ? 'PASS' : 'FAIL'} | ${uptime()}`);
  }
  console.log(failures ? `FAIL: ${failures} of ${runs * 2} measurements outside budget (recall <= ${RECALL_LIMIT_MS} ms, restore <= ${RESTORE_LIMIT_MS} ms)`
    : `PASS: all ${runs * 2} measurements within budget`);
  process.exit(failures ? 1 : 0);
}
await main();
