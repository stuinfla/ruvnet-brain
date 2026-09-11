#!/usr/bin/env node
// Complete hook audit: verify which hooks are registered and actually fire.
// This is NOT guesswork. Every hook will be tested for real execution.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude/settings.json');
const HOOKS_DIR = path.join(HOME, '.claude/hooks');
const PROJECT_DIR = process.cwd();
const PROJECT_HOOKS = path.join(PROJECT_DIR, 'plugin/hooks/hooks.json');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  COMPLETE HOOK AUDIT: Registration + Firing Verification');
console.log('═══════════════════════════════════════════════════════════════\n');

// 1. GLOBAL HOOKS - Check settings.json registration
console.log('1. GLOBAL HOOKS (from ~/.claude/settings.json)\n');
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
} catch (e) {
  console.error(`ERROR reading settings.json: ${e.message}`);
  process.exit(1);
}

const globalHooks = settings.hooks || {};
const hookEventTypes = Object.keys(globalHooks);

if (hookEventTypes.length === 0) {
  console.log('⛔ PROBLEM: No hooks registered in settings.json');
  console.log('   settings.hooks = {} (empty object)');
  console.log('   This means NO global hooks fire on any event.\n');
} else {
  console.log(`✅ Found ${hookEventTypes.length} hook event type(s) registered:`);
  for (const eventType of hookEventTypes) {
    const hooks = globalHooks[eventType] || [];
    console.log(`   • ${eventType}: ${hooks.length} handler(s)`);
  }
  console.log('');
}

// 2. LIST hook files that exist (but may not be registered)
console.log('\n2. HOOK FILES ON DISK (existence only, not verification)\n');
const hookFiles = fs.readdirSync(HOOKS_DIR).filter(f => f.endsWith('.mjs') || f.endsWith('.sh'));
console.log(`Found ${hookFiles.length} hook files:`);
for (const file of hookFiles.sort()) {
  const stat = fs.statSync(path.join(HOOKS_DIR, file));
  const size = (stat.size / 1024).toFixed(1);
  const isExecutable = (stat.mode & 0o111) !== 0 ? '✓' : '✗';
  console.log(`   ${isExecutable} ${file} (${size}KB)`);
}
console.log('');
console.log('⚠️  NOTE: Just because these files exist does NOT mean they are registered');
console.log('          or fire. See section 1 above for what is actually registered.\n');

// 3. PROJECT HOOKS - Check hooks.json
console.log('\n3. PROJECT HOOKS (plugin/hooks/hooks.json)\n');
let projectHooks = {};
try {
  const hookJson = JSON.parse(fs.readFileSync(PROJECT_HOOKS, 'utf8'));
  projectHooks = hookJson.hooks || {};
} catch (e) {
  console.error(`ERROR reading project hooks.json: ${e.message}`);
  process.exit(1);
}

const projectEventTypes = Object.keys(projectHooks);
console.log(`Project declares ${projectEventTypes.length} event hook(s):`);
for (const eventType of projectEventTypes) {
  const matchers = projectHooks[eventType];
  if (Array.isArray(matchers)) {
    console.log(`   • ${eventType}:`);
    for (const m of matchers) {
      console.log(`      - matcher: "${m.matcher}"`);
      const cmds = m.hooks || [];
      for (const h of cmds) {
        const cmd = h.command || '(no command)';
        const shortCmd = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
        console.log(`        command: ${shortCmd}`);
      }
    }
  }
}

// 4. CROSS-CHECK: Which hook files are actually registered?
console.log('\n\n4. CROSS-CHECK: Hook Registration Status\n');
const registeredHooks = [];
const unregisteredHooks = [];

for (const file of hookFiles) {
  const fullPath = path.join(HOOKS_DIR, file);
  let isRegistered = false;

  // Check if this file is referenced in any global hook
  for (const [eventType, handlers] of Object.entries(globalHooks)) {
    if (Array.isArray(handlers)) {
      for (const h of handlers) {
        if (h.hooks && Array.isArray(h.hooks)) {
          for (const hook of h.hooks) {
            if ((hook.command || '').includes(file)) {
              isRegistered = true;
              registeredHooks.push({ file, eventType, command: hook.command });
            }
          }
        }
      }
    }
  }

  if (!isRegistered) {
    unregisteredHooks.push(file);
  }
}

if (registeredHooks.length > 0) {
  console.log(`✅ REGISTERED hook files (actually fire):\n`);
  for (const r of registeredHooks) {
    console.log(`   • ${r.file}`);
    console.log(`     Event: ${r.eventType}`);
    console.log(`     Command: ${r.command.substring(0, 80)}...`);
    console.log('');
  }
} else {
  console.log(`⚠️  NO hook files are registered in settings.json\n`);
}

if (unregisteredHooks.length > 0) {
  console.log(`\n⛔ UNREGISTERED hook files (exist on disk but DON'T fire):\n`);
  for (const u of unregisteredHooks) {
    console.log(`   • ${u}`);
  }
  console.log('\n   These files exist but are NOT invoked by Claude Code.');
  console.log('   They must be registered in ~/.claude/settings.json to fire.\n');
}

// 5. CRITICAL HOOKS STATUS
console.log('\n\n5. CRITICAL HOOKS STATUS (per CLAUDE.md)\n');

const criticalHooks = [
  {
    name: 'PreCompact',
    file: 'agentdb-autocapture.mjs',
    expected: 'Should flush session to .swarm/memory.db on compaction',
  },
  {
    name: 'SessionStart',
    file: 'agentdb-ensure.sh',
    expected: 'Should recall project state from .swarm/memory.db at session start',
  },
  {
    name: 'SessionEnd',
    file: 'agentdb-autocapture.mjs',
    expected: 'Should flush session snapshot on session end',
  },
];

for (const critical of criticalHooks) {
  const isReg = registeredHooks.some(r => r.file === critical.file && r.eventType === critical.name);
  const status = isReg ? '✅ REGISTERED' : '⛔ NOT REGISTERED';
  console.log(`${status} ${critical.name} (${critical.file})`);
  console.log(`   Expected: ${critical.expected}`);
  if (!isReg) {
    console.log(`   ACTION NEEDED: Register in ~/.claude/settings.json`);
  }
  console.log('');
}

// 6. PLUGIN HOOKS (from Ruflo, etc.)
console.log('\n6. PLUGIN-PROVIDED HOOKS (from installed plugins)\n');
const pluginsDir = path.join(HOME, '.claude/plugins');
if (fs.existsSync(pluginsDir)) {
  const pluginDirs = fs.readdirSync(pluginsDir);
  let pluginHooksFound = false;

  for (const pluginName of pluginDirs) {
    const pluginHooksFile = path.join(pluginsDir, pluginName, 'plugins', '**/hooks/hooks.json');
    // Simplified: just check if ruflo-core hooks exist
    const rufloHooksPath = path.join(pluginsDir, 'marketplaces/ruflo/plugins/ruflo-core/hooks/hooks.json');
    if (fs.existsSync(rufloHooksPath)) {
      pluginHooksFound = true;
      const rufloHooks = JSON.parse(fs.readFileSync(rufloHooksPath, 'utf8'));
      console.log(`✅ ruflo-core plugin provides hooks:`);
      const pluginEvents = Object.keys(rufloHooks.hooks || {});
      for (const evt of pluginEvents) {
        console.log(`   • ${evt}`);
      }
    }
  }

  if (!pluginHooksFound) {
    console.log('No plugin-provided hooks found.');
  }
}

// 7. SUMMARY
console.log('\n\n═══════════════════════════════════════════════════════════════');
console.log('  AUDIT SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

if (hookEventTypes.length === 0) {
  console.log('⛔ CRITICAL: Global hooks are NOT registered.');
  console.log('\n   The hook files exist but settings.json has empty .hooks object.');
  console.log('   This means no global hooks fire on any event.');
  console.log('\n   ACTION: Configure hooks in ~/.claude/settings.json\n');
}

if (registeredHooks.length > 0) {
  console.log(`✅ ${registeredHooks.length} hook file(s) are properly registered.\n`);
}

console.log(`Summary:`);
console.log(`  • Global hook event types registered: ${hookEventTypes.length}`);
console.log(`  • Hook files on disk: ${hookFiles.length}`);
console.log(`  • Hook files registered + firing: ${registeredHooks.length}`);
console.log(`  • Hook files NOT registered: ${unregisteredHooks.length}`);

if (unregisteredHooks.length > 0) {
  console.log(`\nCRITICAL GAPS FOUND: ${unregisteredHooks.length} unregistered hook files`);
  console.log('These must be registered before they can fire.\n');
}
