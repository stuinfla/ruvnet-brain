/**
 * --doctor must say ONE thing, and that thing must be true.
 *
 * Two defects, both observed on a real run:
 *   1. It printed "✓ Healthy." from a narrow reading and "✗ FAILING" from a wide one, in the same
 *      output, and exited 0. A reader stops at the first verdict, so the tool told people they were
 *      healthy while its own exit-code logic had already decided otherwise.
 *   2. It called the SessionStart restore and the Stop continuation gate "retired Brain lifecycle
 *      hooks" — the two handlers the policy itself requires — because it assumed the permitted
 *      number was zero instead of asking hook-contracts.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCodexLifecycle, codexLifecycleGuidance } from '../../bin/install.mjs';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'bin/install.mjs'), 'utf8');
const CONTRACTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hook-contracts.json'), 'utf8'));
const PLUGIN_ID = /const CODEX_PLUGIN_ID = '([^']+)'/.exec(INSTALL)?.[1];

const listed = (hooks) => ({ ok: true, value: { data: [{ hooks }] } });
const plugin = { available: true, installed: true, enabled: true };
const wrapper = (id, extra = '') =>
  `node ~/.cache/ruvnet-brain/codex-hook.mjs 9000 ${id}${extra ? ` ${extra}` : ''}`;

describe('--doctor derives its hook judgments from the contracts', () => {
  it('reads the same plugin id the classifier uses', () => {
    expect(PLUGIN_ID, 'CODEX_PLUGIN_ID moved; this fixture is no longer testing the real filter').toBeTruthy();
  });

  it('calls a REGISTERED continuity hook registered, never retired', () => {
    const hooks = continuityRegistrations('codex').map((spec) => ({
      pluginId: PLUGIN_ID,
      event: spec.event,
      command: wrapper(spec.id, spec.event === 'SessionEnd' || spec.event === 'UserPromptSubmit' ? spec.event : ''),
    }));
    const status = classifyCodexLifecycle(plugin, listed(hooks));
    expect(status.state).toBe('continuity-registered');
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(true);
    expect(guidance.summary).not.toMatch(/retired/i);
    expect(guidance.summary).toContain(String(hooks.length));
    // The doctor must not claim Codex capture is broader than what was measured.
    expect(guidance.detail).toContain('SessionEnd only');
    expect(CONTRACTS._codexCapture.fired).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
    expect(Object.keys(CONTRACTS._codexCapture.notObserved).sort()).toEqual(['PreCompact', 'Stop']);
  });

  it('still calls a genuinely stale Brain hook stale', () => {
    const status = classifyCodexLifecycle(plugin, listed([
      { pluginId: PLUGIN_ID, event: 'PreToolUse', command: wrapper('ground-ruvnet') },
    ]));
    expect(status.state).toBe('unexpected-runtime-hooks');
    const guidance = codexLifecycleGuidance(status);
    expect(guidance.healthy).toBe(false);
    expect(guidance.summary).toMatch(/retired/i);
  });

  it('ignores hooks that are not ours, and reports none of ours as inactive-by-design', () => {
    const status = classifyCodexLifecycle(plugin, listed([
      { pluginId: 'someone-else@theirs', event: 'Stop', command: 'node theirs.mjs' },
    ]));
    expect(status.state).toBe('inactive-by-design');
    expect(codexLifecycleGuidance(status).healthy).toBe(true);
  });

  it('surfaces a runtime error as missing-runtime-hooks rather than as health', () => {
    const status = classifyCodexLifecycle(plugin, { ok: true, value: { data: [{ hooks: [], errors: ['boom'] }] } });
    expect(status.state).toBe('missing-runtime-hooks');
    expect(codexLifecycleGuidance(status).healthy).toBe(false);
  });
});

describe('--doctor emits exactly one verdict', () => {
  it('prints "✓ Healthy." and "✗ FAILING" from one place each, in one if/else', () => {
    // The PRINT form, not the string — a comment may quote the verdict; only a console.log emits it.
    const healthy = [...INSTALL.matchAll(/c\.green\('✓ Healthy\.'\)/g)];
    const failing = [...INSTALL.matchAll(/c\.red\('✗ FAILING'\)/g)];
    expect(healthy, 'more than one place prints a Healthy verdict').toHaveLength(1);
    expect(failing, 'more than one place prints a FAILING verdict').toHaveLength(1);
    // And they are the two arms of the SAME branch, so they cannot both run.
    const between = INSTALL.slice(
      Math.min(healthy[0].index, failing[0].index),
      Math.max(healthy[0].index, failing[0].index),
    );
    expect(between, 'the two verdicts are not the arms of one if/else').toMatch(/}\s*else\s*{/);
    expect(between.split('\n').length).toBeLessThan(8);
  });

  it('keeps the narrow install reading from calling itself a verdict', () => {
    // Two lines both labelled "verdict" that answer different questions can disagree in public.
    expect(INSTALL).not.toMatch(/'verdict: Healthy/);
    expect(INSTALL).toMatch(/install reading: present and reachable/);
  });

  it('names the real cause of a smoke failure instead of guessing a reassuring one', () => {
    expect(INSTALL, 'the unconditional "first-run model download" excuse is back')
      .not.toMatch(/no answer came back \(first-run model download/);
    for (const cause of [
      'could not launch the reader',
      'timed out after',
      'was killed by',
      'exited 0 after',
    ]) expect(INSTALL, `smoke failure cause "${cause}" is not reported`).toContain(cause);
  });
});
