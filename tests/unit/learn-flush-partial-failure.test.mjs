import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function flush(actions, failing = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-flush-retry-'));
  dirs.push(dir);
  const queue = path.join(dir, 'queue.jsonl');
  const calls = path.join(dir, 'calls.jsonl');
  // Preserve whitespace and duplicate records too: partial failure must not compact the queue.
  const original = actions.map(action => ` ${JSON.stringify({ tool: 'Bash', action })} `).join('\n') + '\n\n';
  fs.writeFileSync(queue, original);
  const fixture = path.join(dir, 'ruflo-fixture.cjs');
  fs.writeFileSync(fixture, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
process.exit(args.includes(process.env.TEST_FAIL_ACTION) ? 1 : 0);
`);
  const preload = path.join(dir, 'preload.cjs');
  // Only adapt the CLI executable boundary, retaining real synchronous child execution.
  fs.writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = (file, args, options) => {
  if (file !== process.env.RUFLO_BIN) throw new Error('Unexpected executable');
  return original(process.execPath, [process.env.TEST_FIXTURE, ...args], options);
};
require('node:module').syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'plugin/scripts/learn-flush.mjs'), '--sync'], {
    cwd: dir, input: JSON.stringify({ session_id: 'isolated-test' }), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_OPTIONS: '', RUFLO_BIN: process.execPath,
      LEARN_QUEUE: queue, RUVNET_BRAIN_PROJECT_DIR: dir, TEST_CALLS: calls,
      TEST_FIXTURE: fixture, TEST_FAIL_ACTION: failing },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return { queue, original, result, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
}

test.each([['good', 'bad'], ['bad', 'good']])('preserves exact original queue when %s then %s partially fails', (first, second) => {
  const run = flush([first, second, first], 'bad');
  expect(run.calls.map(args => args[3])).toEqual([first, second]);
  expect(fs.existsSync(run.queue), 'failed action must remain retryable').toBe(true);
  expect(fs.readFileSync(run.queue, 'utf8')).toBe(run.original);
  expect(run.result.stderr).toContain('queue is KEPT for retry');
});

test('successful drain still removes the queue', () => {
  const run = flush(['one', 'two']);
  expect(run.calls).toHaveLength(2);
  expect(fs.existsSync(run.queue)).toBe(false);
});

test('successful bounded flush retains only the existing deferred remainder', () => {
  const run = flush(Array.from({ length: 10 }, (_, i) => `action-${i}`));
  expect(run.calls).toHaveLength(8);
  expect(fs.readFileSync(run.queue, 'utf8').trim().split('\n').map(JSON.parse).map(row => row.action)).toEqual(['action-8', 'action-9']);
});

test('partial failure preserves deferred actions and duplicates byte for byte', () => {
  const run = flush(['bad', ...Array.from({ length: 10 }, (_, i) => `action-${i}`), 'bad'], 'bad');
  expect(run.calls).toHaveLength(8);
  expect(fs.readFileSync(run.queue, 'utf8')).toBe(run.original);
});
