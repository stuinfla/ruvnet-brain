#!/usr/bin/env node
/** First-class RuvNet Brain entry point for Dual/TriSmart reviews. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DUAL = path.join(ROOT, 'dual-host-deliberation.mjs');
const TRISMART = path.resolve(ROOT, '..', 'tri-smart-skill', 'tri-smart', 'scripts', 'review.mjs');

function usage() {
  console.log('Usage: node scripts/trismart.mjs [--mode=auto|dual|tri] [--dry-run] <architecture task>');
  console.log('Dual uses Claude Code + Codex; TriSmart adds Grok when its native CLI subscription is verified.');
  console.log('All provider API-key variables are removed before a provider process starts.');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }
const mode = args.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'auto';
if (!['auto', 'dual', 'tri'].includes(mode)) { console.error('mode must be auto, dual, or tri'); process.exit(2); }
const dryRun = args.includes('--dry-run');
const task = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();
if (!task) { usage(); process.exit(2); }

if (dryRun) {
  const providers = mode === 'dual' ? ['claude', 'codex'] : ['claude', 'codex', 'grok'];
  console.log(JSON.stringify({ status: 'ready', mode, providers, models: {
    claude: 'claude-fable-5-1', codex: 'gpt-6-astra', grok: 'grok-4.6',
  }, billingPath: 'native subscription/OAuth CLI; API-key variables unset', taskHash: task.length }, null, 2));
  process.exit(0);
}

// The portable TriSmart runner owns three-provider probing and truthful degraded output.
// The brain's Dual path remains the native two-host implementation and is kept separate so
// a missing Grok CLI can never silently downgrade a requested TriSmart review.
if (mode === 'tri' || mode === 'auto') {
  const result = spawnSync(process.execPath, [TRISMART, `--mode=${mode}`, task], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} else {
  const result = spawnSync(process.execPath, [DUAL, task], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
