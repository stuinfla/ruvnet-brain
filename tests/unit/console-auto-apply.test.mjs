import { describe, expect, it } from 'vitest';
import { autoEligibleIds } from '../../scripts/onboarding-console.mjs';

describe('console autoApply safety boundary', () => {
  it('admits only explicitly opted-in, project-scoped, undoable remedies', () => {
    expect(autoEligibleIds([
      { id: 'repair:memory-index', scope: 'project' },
      { id: 'enable:memory-distillation', scope: 'project' },
      { id: 'reconcile:project', scope: 'project' },
      { id: 'sync:ruflo', scope: 'machine' },
      { id: 'purge:shadows', scope: 'project' },
      { id: 'unknown', scope: 'project' },
    ])).toEqual([
      'repair:memory-index',
      'reconcile:project',
    ]);
  });
});
