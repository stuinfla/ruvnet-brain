#!/usr/bin/env node
/**
 * Friendly first-run setup for TriSmart. It only invokes native OAuth CLIs;
 * it never accepts, reads, or writes provider API keys.
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(root, 'verify-access.mjs');
const dryRun = process.argv.includes('--dry-run');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node setup.mjs [--dry-run]');
  console.log('Guides you through native Claude, Codex, and Grok OAuth login without reading or storing API keys.');
  process.exit(0);
}
const vars = [
  'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_FOUNDRY_API_KEY',
  'OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY','XAI_API_KEY','GROK_API_KEY','XAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'ANTHROPIC_SMALL_FAST_MODEL','ANTHROPIC_FOUNDRY_BASE_URL','GROK_BASE_URL','OPENAI_API_BASE',
  'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_DEFAULT_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT',
];
const env = { ...process.env }; for (const key of vars) delete env[key];
const providers = [
  { key: 'anthropic', label: 'Claude Code', cli: 'claude', login: ['auth', 'login'], model: 'claude-fable-5-1' },
  { key: 'openai', label: 'Codex', cli: 'codex', login: ['login'], model: 'gpt-6-astra' },
  { key: 'xai', label: 'Grok Code', cli: 'grok', login: ['login', '--oauth'], model: 'grok-4.6' },
];
function commandExists(cli) {
  // `where` is the native lookup on Windows; `which` is used elsewhere.
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(lookup, [cli], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && Boolean(r.stdout.trim());
}
function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}
function run(args, inherit = false) {
  return spawnSync(args[0], args.slice(1), { env, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
}
function readVerification(withProbe = false) {
  const r = run([process.execPath, verifier, '--mode=auto', ...(withProbe ? ['--probe'] : [])]);
  try { return { code: r.status ?? 1, result: JSON.parse(`${r.stdout || ''}`) }; } catch { return { code: r.status ?? 1, result: null }; }
}
function explain(result) {
  const mode = result?.mode;
  if (mode === 'tri') console.log('\nTriSmart selected TriSmart: Claude, Codex, and Grok will independently think, challenge one another, and verify the same design.');
  else if (mode === 'dual') console.log(`\nTriSmart selected Dual: ${(result.selectedProviders || []).map((key) => result.auth?.[key]?.cli || key).join(' and ')} will independently think, challenge one another, and verify the same design. A third provider is not required.`);
  else console.log('\nTriSmart is not ready yet. Authenticate Claude and Codex to enable Dual; authenticate Grok as well to enable TriSmart.');
  if (result?.selectedProviders?.length) {
    const labels = { anthropic:'Claude', openai:'Codex', xai:'Grok' };
    const models = result.models || {};
    console.log(`Selected models: ${result.selectedProviders.map((key) => `${labels[key] || key} (${models[key]?.model || 'provider default'})`).join(', ')}.`);
    const fallbacks = result.selectedProviders.filter((key) => models[key]?.preferredModel && models[key]?.model !== models[key]?.preferredModel);
    if (fallbacks.length) console.log('A preferred top model was not included for one or more accounts, so TriSmart is using each provider\'s verified default instead.');
  }
  console.log('The high-end models do the architectural reasoning first. Only after the selected providers agree does the workflow hand ordinary implementation to lower-cost tools.');
}
console.log('TriSmart setup');
console.log('This walkthrough connects only to the native developer CLIs you choose. Login opens each vendor\'s official browser/OAuth flow. API keys are ignored and are never saved.');
const installed = providers.map((p) => ({ ...p, installed: commandExists(p.cli) }));
console.log('\nDetected CLIs:'); for (const p of installed) console.log(`  ${p.installed ? '✓' : '–'} ${p.label} (${p.cli}) — ${p.model}`);
if (installed.some((p) => !p.installed)) console.log('If a CLI is missing, install that provider\'s official developer CLI, then run this setup again. TriSmart never installs unofficial wrappers or asks for API keys.');
if (dryRun) { console.log('\nDry run only: no login or model probe was started.'); process.exitCode = 0; }
else {
  let before = readVerification(false).result;
  for (const p of installed.filter((item) => item.installed && !before?.auth?.[item.key]?.ok)) {
    console.log(`\n${p.label} is not verified. Choose Continue to open its official login flow, or Skip.`);
    const answer = await ask('  Continue? [y/N] ');
    if (answer === 'y' || answer === 'yes') {
      console.log(`Opening ${p.label} login...`);
      const login = run([p.cli, ...p.login], true);
      if (login.status !== 0) console.log(`${p.label} login did not complete (exit ${login.status ?? 'unknown'}).`);
    } else console.log(`Skipped ${p.label}.`);
    before = readVerification(false).result;
  }
  console.log('\nAccess status:');
  const checked = readVerification(false); console.log(JSON.stringify(checked.result, null, 2));
  explain(checked.result);
  const mode = checked.result?.mode;
  if (mode === 'dual' || mode === 'tri') {
    const answer = await ask(`\nRun one real ${mode} marker probe now? It uses subscription allowance. [y/N] `);
    if (answer === 'y' || answer === 'yes') {
      const probed = readVerification(true); console.log(JSON.stringify(probed.result, null, 2));
      explain(probed.result);
      process.exitCode = probed.code;
    } else { console.log('Probe skipped. Access is configured, but model execution remains unverified.'); process.exitCode = 0; }
  } else process.exitCode = 1;
}
