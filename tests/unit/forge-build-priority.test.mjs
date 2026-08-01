import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { lowerBuildPriority } from '../../kb/process-priority.mjs';

describe('RVF build process priority', () => {
  it('requests below-normal priority for the current process before heavy embedding', () => {
    const setPriority = vi.fn();

    const result = lowerBuildPriority({ setPriority });

    expect(setPriority).toHaveBeenCalledExactlyOnceWith(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    expect(result).toEqual({ applied: true, priority: os.constants.priority.PRIORITY_BELOW_NORMAL });
  });

  it('falls back safely when the host does not permit reprioritization', () => {
    const result = lowerBuildPriority({
      setPriority: () => { throw new Error('permission denied'); },
    });

    expect(result).toEqual({
      applied: false,
      priority: os.constants.priority.PRIORITY_BELOW_NORMAL,
      error: 'permission denied',
    });
  });
});
