import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({ workers: [], events: [], terminated: [], failAt: null, taskError: false, stall: false, ignoreTerm: false, neverExit: false }));
vi.mock('node:child_process', () => ({
  fork: (_path, args, options) => new (class extends EventEmitter {
    constructor() {
      super();
      if (state.workers.length === state.failAt) throw new Error('spawn failure');
      this.id = state.workers.length;
      this.args = args; this.options = options;
      state.workers.push(this);
    }
    ref() {} unref() {}
    send({ id, passages, shutdown }) {
      if (shutdown) {
        state.events.push(`start:${this.id}`);
        this.finish = () => {
          state.events.push(`end:${this.id}`);
          this.emit(this.id === 0 ? 'error' : 'exit', this.id === 0 ? new Error('shutdown failed') : 0);
        };
        return;
      }
      if (state.stall) return;
      queueMicrotask(() => this.emit('message', state.taskError
        ? { id, error: 'task failure' } : { id, scores: passages.map(Number) }));
    }
    kill(signal) {
      state.terminated.push(this.id);
      if (state.neverExit) return true;
      if (state.ignoreTerm && signal === 'SIGTERM') return true;
      queueMicrotask(() => this.emit('exit', 1));
      return true;
    }
  })(),
}));
vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }));
vi.mock('../../kb/resolve-deps.mjs', () => ({ loadTransformers: async () => ({ T: {
  env: {}, AutoTokenizer: { from_pretrained: async () => (_q, opts) => opts },
  AutoModelForSequenceClassification: { from_pretrained: async () => async (input) => ({
    logits: { dims: [input.text_pair.length, 1], data: input.text_pair.map(Number) },
  }) },
} }) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules(); });
async function setup() {
  state.workers = []; state.events = []; state.terminated = []; state.failAt = null; state.taskError = false;
  state.stall = false; state.ignoreTerm = false; state.neverExit = false;
  vi.stubEnv('CE_WORKERS', '4'); vi.stubEnv('CE_PARALLEL_MIN', '1'); vi.stubEnv('CE_FORCE_WORKER_FAIL', '');
  return import('../../kb/forge-rerank.mjs');
}
const docs = Array.from({ length: 24 }, (_, i) => ({ path: `p${i}`, fullText: String(i) }));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function drain() {
  await tick();
  for (const worker of state.workers) {
    expect(state.events).toEqual(Array.from({ length: worker.id }, (_, i) => [`start:${i}`, `end:${i}`]).flat().concat(`start:${worker.id}`));
    worker.finish(); await tick();
  }
}
it('serializes shutdown, escalates a graceful failure, and concurrent callers await the same cleanup', async () => {
  const mod = await setup();
  await mod.rerankPairs('q', docs);
  const first = mod.ceWorkerShutdown();
  let done = false;
  const second = mod.ceWorkerShutdown().then(() => { done = true; });
  await tick(); expect(done).toBe(false);
  await drain(); await Promise.all([first, second]);
  expect(done).toBe(true); expect(mod.ceWorkerStats().poolSize).toBe(0);
  expect(state.terminated).toEqual([0]);
  expect(state.workers[0].args[0]).toBe('--ce-worker');
  expect(state.workers[0].options).toMatchObject({ serialization: 'advanced', execPath: process.execPath });
});
it('runtime fallback waits for serialized cleanup and still scores inline', async () => {
  const mod = await setup(); state.taskError = true;
  const scoring = mod.rerankPairs('q', docs);
  await drain();
  const result = await scoring;
  expect(result).toHaveLength(24);
  expect(mod.ceWorkerStats()).toMatchObject({ poolBroken: true, inlineCalls: 1 });
});
it('partial construction failure drains every created worker before inline fallback', async () => {
  const mod = await setup(); state.failAt = 2;
  const scoring = mod.rerankPairs('q', docs);
  await drain();
  expect(await scoring).toHaveLength(24);
  expect(state.events).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);
});
it('task deadline and ignored TERM escalate to KILL, then fallback is counted inline rather than parallel', async () => {
  const mod = await setup(); state.stall = true; state.ignoreTerm = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const scoring = mod.rerankPairs('q', docs);
  await tick();
  await vi.advanceTimersByTimeAsync(270_000);
  expect(await scoring).toHaveLength(24);
  expect(mod.ceWorkerStats()).toMatchObject({ poolBroken: true, inlineCalls: 1, parallelCalls: 0, childResponses: 0 });
  for (let id = 0; id < 4; id++) expect(state.terminated.filter((x) => x === id).length).toBeGreaterThanOrEqual(2);
});
it('failed reaping drains remaining children and every shutdown caller observes the same AggregateError', async () => {
  const mod = await setup(); vi.stubEnv('CE_WORKERS', '2');
  await mod.rerankPairs('q', docs);
  state.neverExit = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const first = mod.ceWorkerShutdown().catch((error) => error);
  const second = mod.ceWorkerShutdown().catch((error) => error);
  await tick(); state.workers[0].finish();
  await vi.advanceTimersByTimeAsync(2000);
  state.workers[1].finish();
  const error = await first;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toHaveLength(1);
  expect(await second).toBe(error);
  expect(await mod.ceWorkerShutdown().catch((e) => e)).toBe(error);
  expect(state.events).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);
});
