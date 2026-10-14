import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptContext } from '../../scripts/user-model-prompt-hook.mjs';

test('prompt recommendation keeps sensitive text on stdin and states execution boundary', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ schemaVersion: 1, reviewedAt: new Date().toISOString() }));
    const prompt = 'summarize synthetic-secret-test-only';
    const context = promptContext({ prompt }, { routerDir, cycle: () => ({ status: 'current', checkedAt: '2026-10-04T14:00:00Z', reviewRequired: false }), run(command, args, options) {
      assert.equal(args.join(' ').includes(prompt), false);
      assert.equal(options.input, prompt);
      assert.equal(options.timeout, 1500);
      return { status: 0, stdout: JSON.stringify({ model: 'gpt-6-luna', effort: 'low' }) };
    } });
    assert.match(context, /gpt-6-luna, effort low/);
    assert.match(context, /does not switch the active parent/);
    assert.equal(context.includes(prompt), false);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});

test('invalid expiry and inventory-only assessment cannot certify routing review', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ schemaVersion: 1, reviewedAt: new Date().toISOString(), maxAgeMs: 'invalid' }));
    const context = promptContext({ prompt: 'build it' }, { routerDir, cycle: () => ({ status: 'blocked', reason: 'inventory unavailable' }), run() { assert.fail('invalid allocation must not select'); } });
    assert.match(context, /missing or invalid/);
    assert.match(context, /do not claim no changes or a completed review/);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});

test('stale approval is retained without claiming fresh evidence', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify({ schemaVersion: 1, reviewedAt: '2020-01-01T00:00:00Z' }));
    const context = promptContext({ prompt: 'fix code' }, { routerDir, cycle: () => ({status:'blocked',launched:false}), run() { return {status:0,stdout:JSON.stringify({model:'gpt-6.1-sol',effort:'medium'})}; } });
    assert.match(context, /older than seven days/);
    assert.match(context, /Retain the owner-approved allocation/);
    assert.match(context, /gpt-6.1-sol, effort medium/);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});

test('unchanged release check does not claim semantic review or trigger an analyst', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    const context = promptContext({}, { routerDir, cycle: () => ({status:'current',checkedAt:'2026-10-04T14:00:00Z',reviewRequired:false}) });
    assert.match(context, /Weekly model-release check current/);
    assert.match(context, /Full assessment runs only for newly discovered/);
    assert.doesNotMatch(context, /semantic routing review completed/);
  } finally { fs.rmSync(routerDir, {recursive:true,force:true}); }
});

test('the prompt hook only reads weekly state: a due cycle is reported, never claimed or launched (4.7.1)', async () => {
  // Before 4.7.1 every prompt called maybeLaunchWeeklyCycle, which claimed the cycle and spawned a detached
  // run that launched native claude/codex. The weekly cycle now runs from the LaunchAgent only.
  const cycleModule = await import('../../scripts/model-weekly-cycle.mjs');
  assert.equal('maybeLaunchWeeklyCycle' in cycleModule, false, 'no prompt-path launcher may exist');
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  const guard = process.env.MODEL_ROUTER_WEEKLY_ANALYST; process.env.MODEL_ROUTER_WEEKLY_ANALYST = '1'; // keeps the pre-fix code from spawning in this test
  try {
    const context = promptContext({}, { routerDir });
    assert.match(context, /weekly model-release check is due/i);
    assert.match(context, /LaunchAgent/);
    assert.deepEqual(fs.readdirSync(routerDir), []);
  } finally {
    if (guard === undefined) delete process.env.MODEL_ROUTER_WEEKLY_ANALYST; else process.env.MODEL_ROUTER_WEEKLY_ANALYST = guard;
    fs.rmSync(routerDir, { recursive: true, force: true });
  }
});

test('every injected routing sentence says advice only and never claims enforcement (4.7.1)', () => {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-prompt-'));
  try {
    const run = () => ({ status: 0, stdout: JSON.stringify({ model: 'gpt-6-luna', effort: 'low' }) });
    const seen = [];
    for (const policy of [{ schemaVersion: 1, reviewedAt: new Date().toISOString() }, { schemaVersion: 1, reviewedAt: '2020-01-01T00:00:00Z' }, { broken: true }]) {
      fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), JSON.stringify(policy));
      for (const weekly of [{ status: 'current', checkedAt: '2026-10-04T14:00:00Z', reviewRequired: false }, { status: 'due', reviewRequired: false },
        { status: 'review-pending', reviewRequired: true }, { status: 'blocked', reason: 'x' }]) {
        seen.push(promptContext({ prompt: 'fix code' }, { routerDir, run, cycle: () => weekly }));
      }
    }
    const all = seen.join('\n');
    assert.doesNotMatch(all, /enforce(?:ment|d)? (?:by|through|via)|for actual launch enforcement|managed route|Use the managed dispatcher|before managed dispatch/i);
    assert.match(seen[0], /Routing advice for this prompt \(advice only, not enforced\): gpt-6-luna, effort low/);
    assert.match(seen[0], /advice only/);
    assert.match(seen.at(-1), /missing or invalid/);
  } finally { fs.rmSync(routerDir, { recursive: true, force: true }); }
});
