import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installTerminalLaunchers } from '../../scripts/model-terminal-launchers.mjs';
import { maintenance } from '../../plugin/scripts/developer-update-maintenance.mjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, data, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }); };
function fixture({ restoreFailure = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-owner-')));
  const manager = path.join(home, '.codex/packages/standalone'), native = path.join(manager, 'releases/1.0.0/bin/codex');
  const later = path.join(manager, 'releases/2.0.0/bin/codex');
  // Exact-literal executable identities are fixture bytes, never live commands.
  for (const file of [native, later, path.join(home, 'node'), path.join(home, 'claude')]) write(file, Buffer.from('7f454c460001', 'hex'), 0o755);
  fs.symlinkSync(path.dirname(path.dirname(native)), path.join(manager, 'current'));
  const source = `export { installTerminalLaunchers } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/model-terminal-launchers.mjs')).href)};\n`;
  const files = { 'scripts/model-terminal-launchers.mjs': restoreFailure ? 'export function installTerminalLaunchers(){throw Error("fixture restoration failed");}\n' : source,
    'scripts/model-terminal-gateway.mjs': '// fixture', 'scripts/claude-terminal-mod.mjs': '// fixture', 'scripts/model-router-engine.mjs': '// fixture' };
  const identity = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => [file, sha(bytes)]);
  const digest = sha(JSON.stringify(identity)), runtimeRoot = path.join(home, '.cache/ruvnet-brain/model-routing/versions', digest);
  for (const [file, bytes] of Object.entries(files)) write(path.join(runtimeRoot, file), bytes);
  installTerminalLaunchers({ home, runtimeRoot, runtimeDigest: digest, realCodex: native, realClaude: path.join(home, 'claude'), nodeBinary: path.join(home, 'node'), apply: true, manageZsh: false });
  const file = path.join(home, '.local/bin/codex'), original = fs.readFileSync(file);
  const config = path.join(home, '.cache/ruvnet-brain/model-routing/terminal-launcher-config.json');
  return { home, manager, native, later, runtimeRoot, file, original, config };
}
async function scenario(options = {}) {
  const f = fixture(options), calls = []; let observed;
  const claudeBefore = fs.readFileSync(path.join(f.home, '.local/bin/claude'));
  const runner = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'update') {
      assert.equal(command, f.native);
      fs.rmSync(f.file); fs.symlinkSync(options.foreign ? path.join(f.home, 'claude') : f.later, f.file);
      return { exitCode: options.commandFailure ? 7 : 0, stdout: '' };
    }
    return { exitCode: 0, stdout: `codex-cli ${command === f.native ? '1.0.0' : options.regression ? '0.1.0' : '2.0.0'}` };
  };
  return { f, calls, claudeBefore, run: () => maintenance({ native: true }, runner, false, { home: f.home, progress: x => { observed = x; } }), receipt: () => observed };
}
test('native update preserves exact Brain wrapper, updates true owner and retains Claude integration', async () => {
  const s = await scenario();
  try {
    const result = await s.run();
    assert.equal(result.stages[0].state, 'completed');
    assert.equal(result.stages[0].originalTarget, s.f.native);
    assert.equal(result.stages[0].currentTarget, s.f.later);
    assert.ok(fs.readFileSync(s.f.file).equals(s.f.original));
    assert.ok(fs.readFileSync(path.join(s.f.home, '.local/bin/claude')).equals(s.claudeBefore));
    const config = JSON.parse(fs.readFileSync(s.f.config));
    assert.equal(config.realCodex, s.f.later); assert.equal(config.realClaude, path.join(s.f.home, 'claude'));
    assert.deepEqual(s.calls.map(x => x.command), [s.f.native, s.f.native, s.f.later]);
  } finally { fs.rmSync(s.f.home, { recursive: true, force: true }); }
});
for (const tamper of ['wrapper', 'config', 'runtime', 'foreign-native', 'claude-wrapper']) test(`rejects ${tamper} before executing updates`, async () => {
  const f = fixture(); let calls = 0;
  try {
    if (tamper === 'wrapper') fs.appendFileSync(f.file, '# custom\n');
    if (tamper === 'config') { const c = JSON.parse(fs.readFileSync(f.config)); c.runtimeDigest = '0'.repeat(64); fs.writeFileSync(f.config, JSON.stringify(c)); }
    if (tamper === 'runtime') fs.appendFileSync(path.join(f.runtimeRoot, 'scripts/model-terminal-launchers.mjs'), '// tampered');
    if (tamper === 'foreign-native') { const c = JSON.parse(fs.readFileSync(f.config)); c.realCodex = path.join(f.home, 'claude'); fs.writeFileSync(f.config, JSON.stringify(c)); }
    if (tamper === 'claude-wrapper') fs.appendFileSync(path.join(f.home, '.local/bin/claude'), '# custom\n');
    const before = fs.readFileSync(f.file);
    await assert.rejects(maintenance({ native: true }, () => { calls++; }, false, { home: f.home }));
    assert.equal(calls, 0); assert.ok(fs.readFileSync(f.file).equals(before));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
for (const options of [{ commandFailure: true }, { regression: true }, { restoreFailure: true }, { foreign: true }]) test(`failed update never completes: ${JSON.stringify(options)}`, async () => {
  const s = await scenario(options);
  try {
    await assert.rejects(s.run());
    assert.notEqual(s.receipt().stages[0].state, 'completed');
    if (options.regression || options.commandFailure) {
      assert.ok(fs.readFileSync(s.f.file).equals(s.f.original));
      assert.equal(JSON.parse(fs.readFileSync(s.f.config)).realCodex, s.f.native);
    }
  } finally { fs.rmSync(s.f.home, { recursive: true, force: true }); }
});
test('dry run executes only real-owner version checks and changes no wrapper/config', async () => {
  const f = fixture(), before = fs.readFileSync(f.config), calls = [];
  try {
    await maintenance({ native: true }, (command, args) => { calls.push({ command, args }); return { exitCode: 0, stdout: 'codex-cli 1.0.0' }; }, true, { home: f.home });
    assert.equal(calls.length, 2); assert.ok(calls.every(x => x.command === f.native && x.args[0] === '--version'));
    assert.ok(fs.readFileSync(f.file).equals(f.original)); assert.ok(fs.readFileSync(f.config).equals(before));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
