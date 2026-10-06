import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import { learningFixture } from '../helpers/learning-fixture.mjs';
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
function setup(actions) {
  const f = learningFixture(); fixtures.push(f);
  const original = actions.map(action => ` ${JSON.stringify({ tool: 'Bash', action })} `).join('\n') + '\n\n';
  const file = f.write('old-session', original); return { ...f, file, original };
}

test.each([['git status', 'npm test'], ['npm test', 'git status']])('partial failure retains exact bytes and acknowledges successful siblings %s %s', (first, second) => {
  const f = setup([first, second, first]);
  const run = f.run(undefined, undefined, { TEST_FAIL_ACTION: 'npm test' });
  expect(run.status, run.stderr).toBe(0);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(f.original);
  expect(f.depth()).toBe(first === 'npm test' ? 2 : 1);
  expect(run.stdout).toContain('original queue is KEPT');
  f.run(); expect(f.depth()).toBe(0);
});

test('successful drain retains original history with no pending work', () => {
  const f = setup(['git status', 'npm test']);
  f.run(); expect(f.depth()).toBe(0);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(f.original);
  expect(f.readCalls()).toHaveLength(2);
});

test('bounded eight deliveries retain deferred records exactly', () => {
  const f = setup(Array.from({ length: 10 }, () => 'npm test'));
  f.run(); expect(f.readCalls()).toHaveLength(8); expect(f.depth()).toBe(2);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(f.original);
  f.run(); expect(f.depth()).toBe(0);
});

test('failed and malformed records survive byte for byte', () => {
  const f = setup(['npm test']);
  fs.appendFileSync(f.file, 'private raw malformed sentinel\n{"tool":"Bash","action":"git status"');
  const original = fs.readFileSync(f.file);
  f.run(undefined, undefined, { TEST_FAIL_ACTION: 'npm test' });
  expect(fs.readFileSync(f.file)).toEqual(original); expect(f.depth()).toBe(3);
});
