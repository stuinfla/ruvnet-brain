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
