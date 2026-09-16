import { describe, expect, it } from 'vitest';
import { classifyRefreshState } from '../../scripts/onboarding-console.mjs';

describe('console refresh state contract', () => {
  it.each([
    [{}, 'started'],
    [{ running: true, runId: 'run-1' }, 'already-running'],
    [{ debounced: true, runId: 'run-1' }, 'already-running'],
    [{ disabled: true }, 'disabled'],
    [{ failed: 'exit 1', runId: 'run-1' }, 'failed'],
  ])('classifies %j as %s', (input, status) => {
    expect(classifyRefreshState(input)).toMatchObject({ status });
  });

  it('retains the run identity and failure reason for asynchronous failure', () => {
    expect(classifyRefreshState({ failed: 'signal SIGTERM', runId: '123-456' }))
      .toEqual({ status: 'failed', runId: '123-456', error: 'signal SIGTERM' });
  });
});
