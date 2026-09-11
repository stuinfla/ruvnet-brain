#!/usr/bin/env node
/** Install TriSmart into one or all supported project-local skill directories. */
import { cpSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.1.0';

const args = process.argv.slice(2);
if (Number.parseInt(process.versions.node.split('.')[0], 10) < 18) {
  console.error(`TriSmart Skill requires Node.js 18 or newer. Found ${process.version}. Install Node from https://nodejs.org/ and run this installer again.`);
  process.exit(2);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node install.mjs [--host=claude|codex|grok|all] [--project=PATH] [--dry-run] [--no-setup] [--force]');
  console.log('Guided path: installs the same TriSmart Skill for the selected host(s), then starts guided OAuth setup.');
  console.log('Manual path: drag the tri-smart folder into the host skill directory shown in README.md.');
  process.exit(0);
}
if (args.includes('--version')) { console.log(`TriSmart Skill ${VERSION}`); process.exit(0); }
const host = (args.find((a) => a.startsWith('--host='))?.slice(7) || 'all').toLowerCase();
const defaultProject = process.env.HOME || process.env.USERPROFILE || process.cwd();
const project = path.resolve(args.find((a) => a.startsWith('--project='))?.slice(10) || defaultProject);
const dryRun = args.includes('--dry-run');
const noSetup = args.includes('--no-setup');
const force = args.includes('--force');
const roots = { claude: '.claude/skills', codex: '.agents/skills', grok: '.grok/skills' };
const hosts = host === 'all' ? Object.keys(roots) : [host];
if (!hosts.every((item) => Object.hasOwn(roots, item))) { console.error('host must be claude, codex, grok, or all'); process.exit(2); }
if (!existsSync(project)) { console.error(`Project directory does not exist: ${project}`); process.exit(2); }
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tri-smart');
console.log(`TriSmart Skill ${VERSION} installation options:`);
console.log('  Guided: continue and this program copies the skill into the selected host directories.');
console.log('  Manual: stop here and drag the tri-smart folder into .claude/skills, .agents/skills, or .grok/skills.');
console.log('');
for (const item of hosts) {
  const destination = path.join(project, roots[item], 'tri-smart');
  if (existsSync(destination) && !force) {
    console.log(`Already installed for ${item}; leaving it unchanged. Use --force to replace it.`);
    continue;
  }
  console.log(`${dryRun ? 'Would install' : 'Installing'} TriSmart for ${item}: ${destination}`);
  if (!dryRun) cpSync(source, destination, { recursive: true, force: true });
}
if (!dryRun && !noSetup) {
  console.log('\nStarting the guided TriSmart login walkthrough...');
  const setup = spawnSync(process.execPath, [path.join(source, 'scripts', 'setup.mjs')], { stdio: 'inherit' });
  process.exitCode = setup.status ?? 1;
} else if (dryRun) console.log('\nDry run only: no files changed and no login started.');
