import { describe, expect, it } from 'vitest';
import { classifyRefreshState, settleRefreshState } from '../../scripts/onboarding-console.mjs';

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

  it('does not mistake a settled refresh for a still-running refresh', () => {
    expect(settleRefreshState({ currentRunId: 'run-2', runId: 'run-2', code: 0 }))
      .toEqual({ status: 'settled', runId: 'run-2', error: null });
  });

  it('ignores a stale child exit after a newer refresh run starts', () => {
    expect(settleRefreshState({ currentRunId: 'run-2', runId: 'run-1', code: 9 })).toBeNull();
  });
});
