#!/usr/bin/env node
// Legacy filename: verify forbidden automatic registration is refused without executing its body.
// Uses the actual installed package manifest and doctor, not a synthetic status callback.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const INSTALLED = arg('--installed');
const HOME_DIR = arg('--home'); // the SAME home the `healthy` scenario already installed into

if (!INSTALLED || !HOME_DIR) {
  console.error('usage: node mutate-hook-timeout.mjs --installed <dir> --home <dir>');
  process.exit(2);
}

const pluginRoot = path.join(INSTALLED, 'plugin');
const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
if (!fs.existsSync(hooksFile)) {
  console.error(`[mutate-hook-timeout] FAIL: no installed hooks.json at ${hooksFile} — run the healthy scenario first`);
  process.exit(1);
}

// Legacy filename retained. The current invariant rejects registration without running its body.
const original = fs.readFileSync(hooksFile);
const marker = path.join(HOME_DIR, 'forbidden-hook-executed');
const body = path.join(pluginRoot, 'scripts', 'ci-forbidden-hook.mjs');
fs.writeFileSync(body, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`);
const doc = JSON.parse(original);
doc.hooks ??= {};
doc.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/ci-forbidden-hook.mjs"', timeout: 1 }] }];
fs.writeFileSync(hooksFile, JSON.stringify(doc));
try {
  const r = spawnSync(process.execPath, [path.join(INSTALLED, 'bin', 'install.mjs'), '--doctor', '--hooks'], {
    env: { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR, RUVNET_BRAIN_TEST: '1' },
    input: '', encoding: 'utf8', timeout: 120000,
  });
  console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  if (r.status !== 1 || !/retired registry must not declare event UserPromptSubmit/.test(r.stdout || '')
    || fs.existsSync(marker)) throw new Error('doctor did not reject the forbidden installed registration without executing it');
  console.log('[mutate-hook-timeout] PASS — forbidden registration refused; its body did not execute');
} finally {
  fs.writeFileSync(hooksFile, original);
  fs.rmSync(body, { force: true });
}
