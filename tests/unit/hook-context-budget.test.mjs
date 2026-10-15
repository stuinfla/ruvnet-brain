import { describe, it, expect } from 'vitest';
import { contextBlock, contextFrame, selectContextFrame, renderContextFrame, readContextFrame } from '../../plugin/scripts/hook-context-budget.mjs';

describe('whole-block typed advisory budget', () => {
  it('measures UTF8 and defers a whole rule rather than slicing its multibyte text', () => {
    const rule = '完整规则'.repeat(300);
    const result = selectContextFrame(contextFrame('unprompted-speech', 'UserPromptSubmit', [contextBlock(rule, { id: 'rule' })]));
    expect(result.receipt.deferredCount).toBe(1);
    expect(result.receipt.advisoryBytes).toBeLessThanOrEqual(2048);
    expect(renderContextFrame(result.frame)).not.toContain('完整规则');
    expect(result.frame.blocks).toEqual([]);
    expect(JSON.parse(renderContextFrame(result.frame)).hookSpecificOutput.additionalContext).toBe('');
  });
  it('retains critical grounding or policy text whole and explicitly discloses the exemption', () => {
    const guard = 'Do not bypass permission. '.repeat(1000);
    const result = selectContextFrame(contextFrame('decision-gate', 'PreToolUse', [contextBlock(guard, { id: 'guard', critical: true })]));
    expect(result.frame.blocks[0].text).toBe(guard);
    expect(result.receipt.criticalExemption).toBe(true);
    expect(result.receipt.criticalBytes).toBeGreaterThan(4096);
    expect(result.receipt.scope).toContain('not-whole-turn');
  });
  it('bounds the merged routine event allocation and keeps complete distinct blocks', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => contextBlock('x'.repeat(600), { id: `block-${i}` }));
    const result = selectContextFrame(contextFrame('decision-gate', 'PreToolUse', blocks));
    expect(result.receipt.advisoryBytes).toBeLessThanOrEqual(4096);
    expect(result.receipt.deferredCount).toBeGreaterThan(0);
    expect(result.receipt.deferredIds.length).toBeLessThanOrEqual(8);
    expect(result.frame.blocks.filter((b) => b.id.startsWith('block-')).every((b) => b.text.length === 600)).toBe(true);
  });
  it('does not interpret an ordinary native control or mixed raw output as optional advice', () => {
    expect(readContextFrame({ decision: 'block', reason: 'mandatory correction' })).toBeNull();
    expect(readContextFrame('mixed raw startup state')).toBeNull();
    const frame = contextFrame('unprompted-speech', 'UserPromptSubmit', [contextBlock('small')]);
    const output = JSON.parse(renderContextFrame(selectContextFrame(frame).frame));
    expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
  });
});
