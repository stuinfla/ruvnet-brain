// #423: a user-saved hook-timeout override must survive the next `claude plugin install/update`
// rewrite of hooks.json, the same way ~/.cache/ruvnet-brain/developer-update-config.json already
// survives it for the developer-update channel/scope choice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyHookTimeoutOverrides, loadHookTimeoutOverrides } from '../../plugin/scripts/hook-timeout-overrides.mjs';

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };

function writeInstall(hooks) {
  const installPath = tmp('hto-install-');
  fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  return installPath;
}

function writeOverrides(doc) {
  const dir = tmp('hto-overrides-');
  const file = path.join(dir, 'hook-timeouts.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

const SAMPLE_HOOKS = {
  UserPromptSubmit: [{
    matcher: '*',
    hooks: [
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ground-ruvnet || true', timeout: 10 },
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" unprompted-speech UserPromptSubmit', timeout: 9 },
    ],
  }],
};

describe('loadHookTimeoutOverrides', () => {
  it('is {} when the file does not exist', () => {
    expect(loadHookTimeoutOverrides(path.join(tmp('hto-missing-'), 'nope.json'))).toEqual({});
  });

  it('is {} for malformed JSON or the wrong shape', () => {
    const dir = tmp('hto-bad-');
    const badJson = path.join(dir, 'a.json'); fs.writeFileSync(badJson, '{not json');
    const wrongShape = path.join(dir, 'b.json'); fs.writeFileSync(wrongShape, JSON.stringify({ timeouts: [1, 2] }));
    expect(loadHookTimeoutOverrides(badJson)).toEqual({});
    expect(loadHookTimeoutOverrides(wrongShape)).toEqual({});
  });

  it('reads the timeouts map when the file is well-formed', () => {
    const file = writeOverrides({ schemaVersion: 1, timeouts: { 'ground-ruvnet': 20 } });
    expect(loadHookTimeoutOverrides(file)).toEqual({ 'ground-ruvnet': 20 });
  });
});

describe('applyHookTimeoutOverrides', () => {
  it('is a no-op when there is no overrides file', () => {
    const installPath = writeInstall(SAMPLE_HOOKS);
    const result = applyHookTimeoutOverrides({ installPath, overridesPath: path.join(installPath, 'missing.json') });
    expect(result).toEqual({ changed: false, applied: {} });
    expect(JSON.parse(fs.readFileSync(path.join(installPath, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(10);
  });

  it('patches only the matching hook, leaving others untouched', () => {
    const installPath = writeInstall(SAMPLE_HOOKS);
    const overridesPath = writeOverrides({ schemaVersion: 1, timeouts: { 'ground-ruvnet': 20 } });
    const result = applyHookTimeoutOverrides({ installPath, overridesPath });
    expect(result).toEqual({ changed: true, applied: { 'ground-ruvnet': 20 } });
    const manifest = JSON.parse(fs.readFileSync(path.join(installPath, 'hooks', 'hooks.json'), 'utf8'));
    const [ground, speech] = manifest.hooks.UserPromptSubmit[0].hooks;
    expect(ground.timeout).toBe(20);
    expect(speech.timeout).toBe(9); // untouched
  });

  it('clamps an out-of-range value instead of honoring or dropping it', () => {
    const installPath = writeInstall(SAMPLE_HOOKS);
    const overridesPath = writeOverrides({ schemaVersion: 1, timeouts: { 'ground-ruvnet': 999 } });
    const messages = [];
    const result = applyHookTimeoutOverrides({ installPath, overridesPath, maxSeconds: 120, log: (m) => messages.push(m) });
    expect(result.applied['ground-ruvnet']).toBe(120);
    expect(messages.some((m) => m.includes('outside'))).toBe(true);
  });

  it('ignores a non-numeric override without throwing', () => {
    const installPath = writeInstall(SAMPLE_HOOKS);
    const overridesPath = writeOverrides({ schemaVersion: 1, timeouts: { 'ground-ruvnet': 'soon' } });
    const result = applyHookTimeoutOverrides({ installPath, overridesPath });
    expect(result).toEqual({ changed: false, applied: {} });
  });

  it('ignores an override for a hook id that is not in this manifest', () => {
    const installPath = writeInstall(SAMPLE_HOOKS);
    const overridesPath = writeOverrides({ schemaVersion: 1, timeouts: { 'no-such-hook': 20 } });
    const result = applyHookTimeoutOverrides({ installPath, overridesPath });
    expect(result).toEqual({ changed: false, applied: {} });
  });

  it('is idempotent: re-applying the same override reports no change the second time', () => {
    const installPath = writeInstall(SAMPLE_HOOKS);
    const overridesPath = writeOverrides({ schemaVersion: 1, timeouts: { 'ground-ruvnet': 20 } });
    applyHookTimeoutOverrides({ installPath, overridesPath });
    const second = applyHookTimeoutOverrides({ installPath, overridesPath });
    expect(second).toEqual({ changed: false, applied: { 'ground-ruvnet': 20 } });
  });
});
