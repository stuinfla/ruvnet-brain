import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../scripts/capability-registry.mjs';
import { buildCapabilityRecommendations } from '../../scripts/console-engine.mjs';
import { planFor } from '../../scripts/remedy-registry.mjs';
import { autoEligibleIds } from '../../scripts/onboarding-console.mjs';

describe('unavailable project-distillation inverse', () => {
  it('keeps diagnosis visible without advertising a reversible turn-on command', () => {
    const row = CAPABILITIES.find((item) => item.key === 'memory-distillation');
    expect(row).toBeDefined();
    expect(typeof row.detect).toBe('function');
    expect(row.turnOn).toBeNull();
    expect(row.whatItBuysYou).toMatch(/automatic undo is unavailable/i);
  });

  it('does not construct a recommendation even from a stale reversible capability row', () => {
    expect(buildCapabilityRecommendations({ capabilities: [{
      key: 'memory-distillation', state: 'off', scope: 'project',
      evidence: '120 embedded memories, zero patterns',
      whatItBuysYou: 'Mine reusable patterns',
      turnOn: { human: 'Distill with reversible snapshot', cmd: 'node /repo/scripts/distill-project.mjs' },
    }] })).toEqual([]);
  });

  it('retains explicit execution identity but rejects stale IDs at the real auto-apply selector', () => {
    const plan = planFor('enable:memory-distillation');
    expect(plan.exec.script).toBe('scripts/distill-project.mjs');
    expect(plan.exec.usesServerProject).toBe(true);
    expect(plan.autoEligible).toBe(false);
    expect(plan.undo.available).toBe(false);
    expect(plan.undo.human).toMatch(/unavailable/);
    expect(plan.summary).not.toMatch(/reversible/);
    expect(autoEligibleIds([{ id: 'enable:memory-distillation', scope: 'project' }])).toEqual([]);
  });
});
