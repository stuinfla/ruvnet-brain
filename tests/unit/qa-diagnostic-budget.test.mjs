import { describe, expect, it } from 'vitest';
import { diff } from '@vitest/utils/diff';
import config from '../../vitest.config.mjs';

describe('QA diagnostic output budget', () => {
  it('bounds giant source diffs without changing assertion outcomes', () => {
    const source = Array.from({ length: 5000 }, (_, i) => `installer line ${i}`).join('\n');
    const output = diff('required contract', source, config.test.diff);
    expect(output.length).toBeLessThan(8000);
    expect(output).toContain('required contract');
    expect(output).toContain('truncated');
    expect(() => expect(source).toContain('required contract')).toThrow();
  });
});
