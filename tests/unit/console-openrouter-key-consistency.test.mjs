// tests/unit/console-openrouter-key-consistency.test.mjs — RNBC QA 2026-10-01.
//
// The Settings card saves an OpenRouter key ENCRYPTED (SOPS+age) and retires the plaintext field. The
// Savings card's OpenRouter box read only $OPENROUTER_API_KEY or the legacy plaintext field, so after a
// successful save through the console it said "No key added" directly beneath a Settings row saying
// "•••• set" — and route-cheap / the MCP gate (runtimeChildEnv) DO use the encrypted key. One fact,
// one reader: both cards now ask openRouterCredentialStatus().
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const available = has('sops') && has('age-keygen');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-orkey-'));
const saved = {};
let mod;

beforeAll(async () => {
  for (const k of ['OPENROUTER_API_KEY', 'SOPS_AGE_KEY_FILE', 'RUVNET_BRAIN_SECRETS_FILE', 'RUVNET_BRAIN_CONFIG_FILE', 'HOME', 'RUVNET_CONSOLE_ROOT', 'RUVNET_BRAIN_TEST']) saved[k] = process.env[k];
  delete process.env.OPENROUTER_API_KEY;
  process.env.HOME = tmp;
  process.env.RUVNET_CONSOLE_ROOT = tmp;
  process.env.RUVNET_BRAIN_TEST = '1';
  process.env.SOPS_AGE_KEY_FILE = path.join(tmp, 'age.txt');
  process.env.RUVNET_BRAIN_SECRETS_FILE = path.join(tmp, 'secrets.enc.json');
  process.env.RUVNET_BRAIN_CONFIG_FILE = path.join(tmp, '.claude', 'ruvnet-brain', 'config.json');
  if (available) spawnSync('age-keygen', ['-o', process.env.SOPS_AGE_KEY_FILE], { encoding: 'utf8' });
  mod = await import('../../scripts/onboarding-console.mjs');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!available)('OpenRouter key: Settings and Savings agree', () => {
  it('no key anywhere: both say absent', () => {
    expect(mod.gatherConfig().values.openrouterKey).toBe(false);
    expect(mod.gatherRouterEngine().keys.openrouter).toBe(false);
  });

  it('a key saved through the console (encrypted) is reported present by BOTH cards', () => {
    const res = mod.saveConfig({ openrouterKey: 'sk-or-test-0123456789abcdef' });
    expect(res.ok, res.log).toBe(true);
    expect(fs.existsSync(process.env.RUVNET_BRAIN_SECRETS_FILE)).toBe(true);
    // the plaintext never lands in config.json
    const cfg = path.join(tmp, '.claude', 'ruvnet-brain', 'config.json');
    expect(fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : '').not.toContain('sk-or-test');
    expect(mod.gatherConfig().values.openrouterKey).toBe(true);
    expect(mod.gatherRouterEngine().keys.openrouter).toBe(true);
  });
});
