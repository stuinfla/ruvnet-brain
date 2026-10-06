import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planUserModelHooks, applyUserModelHooks, shellQuote } from '../../scripts/user-model-hook-install.mjs';

function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly hook home '));
  fs.mkdirSync(path.join(home, '.claude/model-router/bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.claude/model-router/bin/user-model-prompt-hook.mjs'), '// fixture');
  try { run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function write(home, relative, value) { fs.writeFileSync(path.join(home, relative), JSON.stringify(value)); }

test('dry plan is inert; native registrations append preserving private settings and hook indices', () => fixture(home => {
  const verify = { hooks: [{ type: 'command', command: 'node ~/.codex/hooks/verify-request.mjs', timeout: 5 }] };
  write(home, '.codex/hooks.json', { hooks: { UserPromptSubmit: [verify], Stop: [] }, privateSetting: 123 });
  write(home, '.claude/settings.json', { env: { PRIVATE: 'synthetic' }, hooks: { Stop: [] } });
  fs.chmodSync(path.join(home, '.claude/settings.json'), 0o640);
  // Windows reports its own mode; preserve the observed host value rather than assuming Unix bits.
  const initialMode = fs.statSync(path.join(home, '.claude/settings.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(initialMode, 0o640);
  const before = fs.readFileSync(path.join(home, '.codex/hooks.json'), 'utf8');
  const plan = planUserModelHooks({ home });
  assert.equal(fs.readFileSync(path.join(home, '.codex/hooks.json'), 'utf8'), before);
  const receipt = applyUserModelHooks(plan);
  assert.equal(receipt.written.length, 2);
  const codex = JSON.parse(fs.readFileSync(path.join(home, '.codex/hooks.json')));
  assert.deepEqual(codex.hooks.UserPromptSubmit[0], verify);
  assert.equal(codex.privateSetting, 123);
  assert.equal(codex.hooks.UserPromptSubmit[1].matcher, undefined);
  assert.equal(codex.hooks.UserPromptSubmit[1].hooks[0].timeout, 3);
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json')));
  assert.deepEqual(claude.env, { PRIVATE: 'synthetic' });
  assert.match(claude.hooks.UserPromptSubmit[0].hooks[0].command, / --claude$/);
  assert.equal(fs.statSync(path.join(home, '.claude/settings.json')).mode & 0o777, initialMode);
  assert.equal(fs.readFileSync(receipt.written[1].backup, 'utf8'), before);
  assert.equal(planUserModelHooks({ home }).changes.some(change => change.changed), false);
}));

test('logical node alias of trusted executable recognizes exact existing unmanaged registration', () => fixture(home => {
  const script = path.join(home, '.claude/model-router/bin/user-model-prompt-hook.mjs');
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  write(home, '.claude/settings.json', { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${shellQuote(script)} --claude`, timeout: 3 }] }] } });
  const plan = planUserModelHooks({ home, searchPath: bin });
  assert.equal(plan.changes[0].changed, false);
}));

test('custom overrides and mixed shell commands referencing target fail without clobbering', () => fixture(home => {
  const script = path.join(home, '.claude/model-router/bin/user-model-prompt-hook.mjs');
  const commands = [`node ${shellQuote(script)} --claude && echo custom`, `node ${shellQuote(script)} --claude --custom`, `echo ${shellQuote(script)}`];
  for (const command of commands) {
    write(home, '.claude/settings.json', { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } });
    const before = fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8');
    assert.throws(() => planUserModelHooks({ home }), /Unowned model-hook override/);
    assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), before);
  }
}));

test('duplicate exact ownership, malformed JSON/schema and symlink targets fail closed', () => fixture(home => {
  const file = path.join(home, '.claude/settings.json');
  fs.writeFileSync(file, '{'); assert.throws(() => planUserModelHooks({ home }), /Malformed JSON/);
  write(home, '.claude/settings.json', { hooks: [] }); assert.throws(() => planUserModelHooks({ home }), /Malformed hooks/);
  write(home, '.claude/settings.json', { hooks: { UserPromptSubmit: null } }); assert.throws(() => planUserModelHooks({ home }), /Malformed UserPromptSubmit/);
  const script = path.join(home, '.claude/model-router/bin/user-model-prompt-hook.mjs');
  const group = { hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(script)} --claude` }] };
  write(home, '.claude/settings.json', { hooks: { UserPromptSubmit: [group, group] } });
  assert.throws(() => planUserModelHooks({ home }), /Ambiguous/);
  fs.unlinkSync(file); fs.symlinkSync(path.join(home, '.codex/hooks.json'), file);
  assert.throws(() => planUserModelHooks({ home }), /Symlink/);
}));

test('stale plans cannot overwrite concurrent settings; missing runtime cannot apply', () => fixture(home => {
  const plan = planUserModelHooks({ home });
  write(home, '.codex/hooks.json', { concurrent: true });
  assert.throws(() => applyUserModelHooks(plan), /Config changed/);
  assert.equal(fs.existsSync(path.join(home, '.claude/settings.json')), false);
  const fresh = planUserModelHooks({ home }); fs.unlinkSync(fresh.script);
  assert.throws(() => applyUserModelHooks(fresh), /runtime/);
}));
