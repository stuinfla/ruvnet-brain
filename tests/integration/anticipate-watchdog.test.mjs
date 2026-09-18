import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'anticipate.sh');

function fixture(base, { stalled = false } = {}) {
  const home = path.join(base, 'home');
  const registry = path.join(base, 'registry.mjs');
  const matcher = path.join(base, 'matcher.mjs');
  const outcomes = path.join(base, 'outcomes.mjs');
  const settings = path.join(base, 'settings.json');
  const state = path.join(base, 'state.json');
  const ledger = path.join(base, 'ledger.jsonl');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ version: 1, settings: { advocacy: 'important-only' } }));
  fs.writeFileSync(registry, `export function auditAll() { return [{ key: 'fixture-cap', label: 'Fixture capability', state: 'off', evidence: 'fixture evidence', whatItBuysYou: 'fixture value', turnOn: { cmd: 'ruflo hooks enable' } }]; }\n`);
  fs.writeFileSync(matcher, stalled
    ? `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(base, 'node.pid'))}, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {});\nexport function matchGoal() { return []; }\n`
    : `export function matchGoal() { return [{ capability: 'fixture-cap', confidence: 0.95, why: 'fixture evidence matches this request' }]; }\n`);
  fs.writeFileSync(outcomes, `export const ACTIONS = { OFFERED: 'offered' }; export function shouldStillOffer() { return true; } export function record() { return { ok: true }; }\n`);
  return { home, registry, matcher, outcomes, settings, state, ledger };
}

function run(fx) {
  return spawnSync('/bin/sh', [HOOK], {
    input: JSON.stringify({ session_id: 'watchdog-fixture', prompt: 'please use the fixture capability for this request' }),
    cwd: fx.home,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      HOME: fx.home,
      RUVNET_GOAL_MATCH: fx.matcher,
      RUVNET_CAPABILITY_REGISTRY: fx.registry,
      RUVNET_ADVOCACY_OUTCOMES_MODULE: fx.outcomes,
      RUVNET_SETTINGS_FILE: fx.settings,
      RUVNET_ANTICIPATE_STATE: fx.state,
      RUVNET_ADVOCACY_OUTCOMES: fx.ledger,
    },
  });
}

describe('anticipate.sh watchdog process ownership', () => {
  it('keeps the normal fast path bounded and exits cleanly', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-watchdog-fast-'));
    try {
      const result = run(fixture(base));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('kills a stalled detector within the hook budget without leaving the node child', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-watchdog-stall-'));
    const started = Date.now();
    try {
      const fx = fixture(base, { stalled: true });
      const result = run(fx);
      const elapsed = Date.now() - started;
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(3_000);
      const pid = Number(fs.readFileSync(path.join(base, 'node.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
